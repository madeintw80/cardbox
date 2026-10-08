// 名片盒辨識中繼站（Cloudflare Worker）
// 流程：App 送來「照片＋她的 Google 登入憑證」→ 確認是名單上的 Gmail → 確認今天額度還有 → 請 Claude 讀名片 → 回傳欄位
// 照片讀完就丟，這裡不存任何名片內容。AI 金鑰只放在 Cloudflare 的 secret，App 端拿不到。
//
// 需要的設定（wrangler.jsonc 的 vars／Cloudflare secret）：
//   ANTHROPIC_API_KEY  (secret) Claude API 金鑰（Boss 用 wrangler secret put 自己貼）
//   ALLOWED_EMAILS     (secret) 可以使用的 Gmail，逗號分隔
//   GOOGLE_CLIENT_ID   (var)    App 的 Google OAuth Client ID，用來確認憑證是從名片盒發的
//   ALLOWED_ORIGINS    (var)    允許呼叫的網站，逗號分隔
//   DAILY_LIMIT        (var)    每個帳號每天最多辨識幾張
//   USAGE              (KV, 可選) 記每日用量；沒綁就不限制每日張數

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const MAX_BASE64_LENGTH = 6_000_000; // 約 4.5MB 的圖片；App 會先壓到 400KB 左右，遠低於這個
const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp'];

const SYSTEM_PROMPT = `You read photos of business cards and return structured contact data as JSON.

Rules:
- Copy text exactly as printed. Never translate, never guess, never invent. A field that is not on the card is "".
- name: the person's name in the card's primary script. If the card has Chinese, Japanese or Korean, use that script. name_alt: the same person's name in another script or language if it is printed (for example the English name), otherwise "".
- company, department, title, address: as printed. If the card prints both a CJK and a Latin version, use the CJK version here; the other version still goes in raw_text. Several titles are joined with " / ".
- mobile: mobile or cell numbers (Taiwan mobiles start with 09 or +886 9). phone: office or landline numbers, keeping any extension such as "#123" or "ext. 123". fax: fax numbers. Several numbers in one field are joined with ", ".
- email: every email address, joined with ", ". website: URLs as printed.
- social: LINE, WeChat, Instagram, Facebook and similar IDs with the platform name, for example "LINE: abc123".
- raw_text: every piece of text on the card, top to bottom, one line each.
- is_business_card: false only if the photo is clearly not a business card. The back of a card that shows only a logo or slogan is still a business card.
- The photo may be rotated, tilted, dim or partly glared; read what is legible and leave the rest "".`;

// Claude 必須照這個格式回答（structured outputs：保證是合法 JSON、欄位一個都不少）
const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name', 'name_alt', 'company', 'department', 'title', 'mobile', 'phone', 'fax',
    'email', 'website', 'address', 'social', 'raw_text', 'is_business_card',
  ],
  properties: {
    name: { type: 'string' },
    name_alt: { type: 'string' },
    company: { type: 'string' },
    department: { type: 'string' },
    title: { type: 'string' },
    mobile: { type: 'string' },
    phone: { type: 'string' },
    fax: { type: 'string' },
    email: { type: 'string' },
    website: { type: 'string' },
    address: { type: 'string' },
    social: { type: 'string' },
    raw_text: { type: 'string' },
    is_business_card: { type: 'boolean' },
  },
};

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true }, 200, cors);
    if (url.pathname !== '/ocr' || request.method !== 'POST') {
      return json({ code: 'not_found', error: 'not found' }, 404, cors);
    }
    if (!isAllowedOrigin(origin, env)) {
      return json({ code: 'not_allowed', error: 'origin not allowed' }, 403, cors);
    }

    // 1) 確認是誰：用 Google 憑證問 Google「這是誰的、是不是名片盒發的」
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ code: 'bad_token', error: 'missing token' }, 401, cors);
    const who = await verifyGoogleToken(token, env);
    if (!who.ok) return json({ code: who.code, error: who.error }, who.status, cors);

    // 2) 今天的額度
    const usage = await readDailyUsage(who.email, env);
    if (usage.count >= usage.limit) {
      return json({ code: 'daily_limit', error: `daily limit ${usage.limit} reached` }, 429, cors);
    }

    // 3) 檢查照片
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

    // 4) 請 Claude 讀
    try {
      const { card, usage: tokens } = await readCard(image, mediaType, env);
      ctx.waitUntil(bumpDailyUsage(who.email, usage, env));
      console.log(JSON.stringify({ event: 'ocr_ok', email_hash: await shortHash(who.email), ...tokens }));
      return json({ card, model: MODEL }, 200, cors);
    } catch (err) {
      return aiErrorResponse(err, cors);
    }
  },
};

// ---------- Google 憑證驗證 ----------

// 同一支 Worker 執行期間記住驗過的憑證，批次上傳 50 張時不用問 Google 50 次
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
    return { ok: false, status: 502, code: 'ai_error', error: 'cannot reach google' };
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

// ---------- 每日用量（KV）----------

function taipeiDate() {
  // 台灣時間的日期（UTC+8），過了台灣午夜才算新的一天
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function readDailyUsage(email, env) {
  const limit = Number(env.DAILY_LIMIT) || 200;
  if (!env.USAGE) return { count: 0, limit, key: '' };
  const key = `day:${taipeiDate()}:${await shortHash(email)}`;
  const count = Number(await env.USAGE.get(key)) || 0;
  return { count, limit, key };
}

async function bumpDailyUsage(email, usage, env) {
  if (!env.USAGE || !usage.key) return;
  // KV 不是精準計數器（同時多張可能少算一兩張），當成防暴衝的上限夠用
  const count = Number(await env.USAGE.get(usage.key)) || 0;
  await env.USAGE.put(usage.key, String(count + 1), { expirationTtl: 3 * 24 * 3600 });
}

// Email 不直接寫進 KV／log，存雜湊（看得出是不是同一人，但看不出是誰）
async function shortHash(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Claude 讀名片 ----------

async function readCard(image, mediaType, env) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
  const params = {
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    // 名片辨識不需要深度思考 → effort low（省錢、比較快）；format＝強制照 CARD_SCHEMA 回 JSON
    output_config: { effort: 'low', format: { type: 'json_schema', schema: CARD_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
        { type: 'text', text: 'Read this business card.' },
      ],
    }],
  };

  let response;
  try {
    // 預設開「被安全機制誤擋時自動換模型重試」（fallbacks）
    response = await client.beta.messages.create({
      ...params,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (err) {
    // 萬一這個帳號不支援 fallbacks 參數（400），退回一般呼叫，不要讓整個功能壞掉
    if (err instanceof Anthropic.BadRequestError) response = await client.messages.create(params);
    else throw err;
  }

  if (response.stop_reason === 'refusal') {
    const e = new Error('refused');
    e.code = 'refused';
    throw e;
  }
  if (response.stop_reason === 'max_tokens') {
    const e = new Error('response truncated');
    e.code = 'ai_error';
    throw e;
  }
  const text = response.content.find((b) => b.type === 'text')?.text || '';
  let card;
  try {
    card = JSON.parse(text);
  } catch {
    const e = new Error('ai returned invalid json');
    e.code = 'ai_error';
    throw e;
  }
  return {
    card,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  };
}

function aiErrorResponse(err, cors) {
  console.error(JSON.stringify({ event: 'ocr_error', name: err?.name, status: err?.status, message: String(err?.message).slice(0, 200) }));
  if (err?.code === 'refused') return json({ code: 'refused', error: 'model refused' }, 422, cors);
  if (err instanceof Anthropic.RateLimitError) return json({ code: 'rate_limit', error: 'rate limited' }, 429, cors);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    // 金鑰錯／額度用完：使用者無能為力，要 Boss 去處理
    return json({ code: 'ai_error', error: 'AI 服務設定有問題，請聯絡管理員' }, 502, cors);
  }
  if (err instanceof Anthropic.BadRequestError) {
    return json({ code: 'bad_request', error: 'AI 讀不了這張照片，請重拍' }, 400, cors);
  }
  return json({ code: 'ai_error', error: 'AI 暫時沒回應' }, 502, cors);
}

// ---------- 小工具 ----------

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function isAllowedOrigin(origin, env) {
  return allowedOrigins(env).includes(origin);
}

function corsHeaders(origin, env) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (isAllowedOrigin(origin, env)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
