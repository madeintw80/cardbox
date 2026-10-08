// 名片盒辨識中繼站（Cloudflare Worker）＝「收件櫃」
//
// 為什麼是收件櫃：名片由 Boss 電腦上的 Claude（Boss 的訂閱）來讀。電腦不對外開門，
// 只會「主動」來這裡拿件，所以中間需要一個大家都連得到的櫃子。
//
//   手機 App ──① 放照片──▶ 收件櫃(D1) ◀──② 每幾秒來拿件── Boss 電腦（cardbox_runner.py）
//   手機 App ◀─④ 拿結果──  收件櫃(D1) ◀──③ 放回讀好的欄位──  Boss 電腦
//
// App 端（要她的 Google 登入＋白名單）：
//   POST /jobs          放一張照片進櫃子 → { id }
//   GET  /jobs/:id      看讀好了沒 → { status, card?, error? }
// 電腦端（要 RUNNER_SECRET）：
//   POST /runner/claim  拿最舊的一張（沒有就 204）
//   POST /runner/result 放回結果
//
// 設定（wrangler.jsonc 的 vars／Cloudflare secret）：
//   RUNNER_SECRET      (secret) 電腦端的通行密碼（產生後同時存在 Boss 電腦的 secrets 資料夾）
//   ALLOWED_EMAILS     (secret) 可以使用的 Gmail，逗號分隔
//   GOOGLE_CLIENT_ID   (var)    App 的 Google OAuth Client ID
//   ALLOWED_ORIGINS    (var)    允許呼叫的網站
//   DAILY_LIMIT        (var)    每個帳號每天最多幾張
//   DB                 (D1)     收件櫃
//   USAGE              (KV)     每日用量
//   DEV_FAKE_EMAIL     (只在本機 wrangler dev 用 --var 設) 跳過 Google 驗證的測試帳號；線上沒有這個值

const MAX_BASE64_LENGTH = 1_500_000;      // 約 1.1MB 圖片；App 壓縮後約 300KB
const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp'];
const RUNNER_ONLINE_MS = 60 * 1000;       // 電腦超過 60 秒沒來拿件＝離線
const LEASE_MS = 5 * 60 * 1000;           // 電腦拿走 5 分鐘還沒回結果＝當它當機，別台（或重啟後）可以重拿
const KEEP_DONE_MS = 60 * 60 * 1000;      // 讀完的結果保留 1 小時給 App 來拿
const KEEP_ANY_MS = 24 * 60 * 60 * 1000;  // 任何件最多放 24 小時

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === '/health') return json({ ok: true }, 200, cors);
      if (url.pathname.startsWith('/runner/')) return await handleRunner(request, url, env);
      if (url.pathname === '/jobs' || url.pathname.startsWith('/jobs/')) return await handleApp(request, url, env, cors);
      return json({ code: 'not_found', error: 'not found' }, 404, cors);
    } catch (err) {
      console.error(JSON.stringify({ event: 'unhandled', message: String(err?.message || err).slice(0, 300) }));
      return json({ code: 'server_error', error: '中繼站出錯了，稍後再試' }, 500, cors);
    }
  },
};

// ======================= App 端 =======================

async function handleApp(request, url, env, cors) {
  if (!isAllowedOrigin(origin(request), env)) {
    return json({ code: 'not_allowed', error: 'origin not allowed' }, 403, cors);
  }
  const who = await identify(request, url, env);
  if (!who.ok) return json({ code: who.code, error: who.error }, who.status, cors);
  const owner = await shortHash(who.email);

  // 放照片
  if (url.pathname === '/jobs' && request.method === 'POST') {
    const usage = await readDailyUsage(owner, env);
    if (usage.count >= usage.limit) {
      return json({ code: 'daily_limit', error: `daily limit ${usage.limit} reached` }, 429, cors);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ code: 'bad_request', error: 'invalid json' }, 400, cors);
    }
    const image = typeof body?.image === 'string' ? body.image : '';
    const mediaType = ALLOWED_MEDIA.includes(body?.media_type) ? body.media_type : 'image/jpeg';
    if (!image) return json({ code: 'bad_request', error: 'missing image' }, 400, cors);
    if (image.length > MAX_BASE64_LENGTH) return json({ code: 'too_large', error: 'image too large' }, 413, cors);

    const id = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO jobs (id, owner, status, media_type, image, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(id, owner, 'pending', mediaType, image, Date.now()).run();
    await bumpDailyUsage(usage, env);
    return json({ id, runner_online: await runnerOnline(env) }, 200, cors);
  }

  // 看結果
  const match = url.pathname.match(/^\/jobs\/([0-9a-f-]{36})$/);
  if (match && request.method === 'GET') {
    const job = await env.DB.prepare(
      'SELECT id, owner, status, result, error, created_at FROM jobs WHERE id = ?',
    ).bind(match[1]).first();
    // 不是她的件，就當作不存在（不透露別人的件有沒有存在）
    if (!job || job.owner !== owner) return json({ code: 'not_found', error: 'job not found' }, 404, cors);
    const out = { id: job.id, status: job.status, runner_online: await runnerOnline(env) };
    if (job.status === 'done') out.card = JSON.parse(job.result || '{}');
    if (job.status === 'error') out.error = job.error || '辨識失敗';
    return json(out, 200, cors);
  }

  return json({ code: 'not_found', error: 'not found' }, 404, cors);
}

// 確認是誰：線上一律用 Google 憑證；本機測試才可能用 DEV_FAKE_EMAIL
async function identify(request, url, env) {
  if (env.DEV_FAKE_EMAIL && ['localhost', '127.0.0.1'].includes(url.hostname)) {
    return checkAllowed(String(env.DEV_FAKE_EMAIL).toLowerCase(), env);
  }
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, code: 'bad_token', error: 'missing token' };
  return verifyGoogleToken(token, env);
}

// ======================= 電腦端 =======================

async function handleRunner(request, url, env) {
  if (request.method !== 'POST') return json({ code: 'not_found', error: 'not found' }, 404);
  if (!(await runnerAuthorized(request, env))) {
    return json({ code: 'not_allowed', error: 'bad runner secret' }, 403);
  }
  const now = Date.now();

  if (url.pathname === '/runner/claim') {
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('runner_seen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(String(now)).run();
    // 順手清掉過期的件（讀完 1 小時、或放超過 24 小時）
    await env.DB.prepare(
      "DELETE FROM jobs WHERE (status IN ('done', 'error') AND finished_at < ?) OR created_at < ?",
    ).bind(now - KEEP_DONE_MS, now - KEEP_ANY_MS).run();
    // 一個 SQL 指令完成「挑最舊的一件＋標記成處理中」，兩個執行緒同時來也不會拿到同一件
    const job = await env.DB.prepare(
      `UPDATE jobs SET status = 'working', claimed_at = ?
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'pending' OR (status = 'working' AND claimed_at < ?)
         ORDER BY created_at LIMIT 1
       )
       RETURNING id, media_type, image`,
    ).bind(now, now - LEASE_MS).first();
    if (!job) return new Response(null, { status: 204 });
    return json({ id: job.id, media_type: job.media_type, image: job.image }, 200);
  }

  if (url.pathname === '/runner/result') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ code: 'bad_request', error: 'invalid json' }, 400);
    }
    if (!body?.id) return json({ code: 'bad_request', error: 'missing id' }, 400);
    const ok = body.card && typeof body.card === 'object';
    // 讀完就把照片從櫃子刪掉（image 設成 NULL），只留文字結果給 App 拿
    await env.DB.prepare(
      'UPDATE jobs SET status = ?, result = ?, error = ?, image = NULL, finished_at = ? WHERE id = ?',
    ).bind(
      ok ? 'done' : 'error',
      ok ? JSON.stringify(body.card) : null,
      ok ? null : String(body.error || '辨識失敗').slice(0, 300),
      now,
      body.id,
    ).run();
    return json({ ok: true }, 200);
  }

  return json({ code: 'not_found', error: 'not found' }, 404);
}

// 比對電腦端密碼（逐字元固定時間比對，避免被用「回應快慢」猜密碼）
async function runnerAuthorized(request, env) {
  const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const expected = String(env.RUNNER_SECRET || '');
  if (!given || !expected) return false;
  const a = new TextEncoder().encode(await sha256Hex(given));
  const b = new TextEncoder().encode(await sha256Hex(expected));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function runnerOnline(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'runner_seen'").first();
  return !!row && Date.now() - Number(row.value) < RUNNER_ONLINE_MS;
}

// ======================= Google 憑證驗證 =======================

// 同一支 Worker 執行期間記住驗過的憑證，批次上傳時不用一直問 Google
const tokenCache = new Map();

async function verifyGoogleToken(token, env) {
  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached && cached.exp > now) return checkAllowed(cached.email, env);

  let info;
  try {
    const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
    if (!resp.ok) return { ok: false, status: 401, code: 'bad_token', error: 'google rejected token' };
    info = await resp.json();
  } catch {
    return { ok: false, status: 502, code: 'server_error', error: 'cannot reach google' };
  }
  // aud／azp 一定要是名片盒用的 Client ID，別的網站發的憑證不收
  if (info.aud !== env.GOOGLE_CLIENT_ID && info.azp !== env.GOOGLE_CLIENT_ID) {
    return { ok: false, status: 401, code: 'bad_token', error: 'token not issued for this app' };
  }
  if (!info.email || String(info.email_verified) !== 'true') {
    return { ok: false, status: 401, code: 'bad_token', error: 'email missing or unverified' };
  }
  const email = String(info.email).toLowerCase();
  const exp = Number(info.exp) * 1000 || now + 5 * 60 * 1000;
  if (tokenCache.size > 200) tokenCache.clear();
  tokenCache.set(token, { email, exp });
  return checkAllowed(email, env);
}

function checkAllowed(email, env) {
  const allowed = String(env.ALLOWED_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(email)) {
    return { ok: false, status: 403, code: 'not_allowed', error: 'email not in allowlist' };
  }
  return { ok: true, email };
}

// ======================= 每日用量（KV）=======================

function taipeiDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function readDailyUsage(owner, env) {
  const limit = Number(env.DAILY_LIMIT) || 200;
  if (!env.USAGE) return { count: 0, limit, key: '' };
  const key = `day:${taipeiDate()}:${owner}`;
  const count = Number(await env.USAGE.get(key)) || 0;
  return { count, limit, key };
}

async function bumpDailyUsage(usage, env) {
  if (!env.USAGE || !usage.key) return;
  // KV 不是精準計數器，當成防暴衝的上限夠用
  await env.USAGE.put(usage.key, String(usage.count + 1), { expirationTtl: 3 * 24 * 3600 });
}

// ======================= 小工具 =======================

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Email 不直接存進資料庫／log，存雜湊（看得出是不是同一人，但看不出是誰）
async function shortHash(text) {
  return (await sha256Hex(text)).slice(0, 16);
}

function origin(request) {
  return request.headers.get('Origin') || '';
}

function isAllowedOrigin(value, env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).includes(value);
}

function corsHeaders(value, env) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (isAllowedOrigin(value, env)) headers['Access-Control-Allow-Origin'] = value;
  return headers;
}

function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
