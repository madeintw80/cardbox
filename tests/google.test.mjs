// Google 後端測試：用「假的 Google API」模擬一張 v0.2.0 建的舊試算表（只有 Cards 分頁、20 欄），
// 確認新版打開時會自動補上 Companies 分頁和新欄位標題、舊資料不會錯位，公司檔案也能增刪改。
// 用法：node --test C:/Users/User/projects/CardBox/tests/google.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- 瀏覽器環境的替身（google.js 用到 localStorage、location、fetch）----
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
globalThis.location = { search: '' };

// ---- 假的試算表：tabs = { 分頁名: { sheetId, rows: [[...], ...] } } ----
const OLD_HEADER = ['id', 'created_at', 'updated_at', 'name', 'name_alt', 'company', 'department', 'title', 'mobile',
  'phone', 'fax', 'email', 'website', 'address', 'social', 'note', 'tags', 'photos', 'status', 'raw_text'];
const oldCard = ['c_old1', '2026-10-26T16:46:03Z', '2026-10-26T16:46:03Z', '小美', '', '', '花園會館', '芳療師', '',
  '02-1234-5678', '', '', '', '台北市測試路 1 號', '', '', '', '["p1"]', 'ok', '原始文字'];
const sheet = { id: 'SHEET1', tabs: { Cards: { sheetId: 0, rows: [OLD_HEADER, oldCard] } } };
const calls = [];

function colIndex(letters) {
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}
// "Cards!A2:U" → { tab, r1, c1, r2, c2 }（列從 0 起算；r2 = null 表示到最後）
function parseRange(a1) {
  const [tab, ref] = a1.split('!');
  const [start, end = start] = ref.split(':');
  const p = (s) => { const m = /^([A-Z]+)(\d*)$/.exec(s); return { c: colIndex(m[1]), r: m[2] ? Number(m[2]) - 1 : null }; };
  const s = p(start);
  const e = p(end);
  return { tab, r1: s.r ?? 0, c1: s.c, r2: e.r, c2: e.c };
}
function readRange(a1) {
  const { tab, r1, c1, r2, c2 } = parseRange(a1);
  const rows = sheet.tabs[tab].rows;
  const out = rows.slice(r1, r2 == null ? undefined : r2 + 1).map((row) => {
    const cut = row.slice(c1, c2 + 1);
    while (cut.length && cut[cut.length - 1] === '') cut.pop(); // Google 會省略尾巴的空格
    return cut;
  });
  while (out.length && !out[out.length - 1].length) out.pop();
  return out;
}
function writeRange(a1, values) {
  const { tab, r1, c1 } = parseRange(a1);
  const rows = sheet.tabs[tab].rows;
  values.forEach((vals, i) => {
    const row = rows[r1 + i] || (rows[r1 + i] = []);
    vals.forEach((v, j) => { row[c1 + j] = v; });
  });
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const u = new URL(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push(`${method} ${decodeURIComponent(u.pathname.replace(/^.*\/spreadsheets\/SHEET1/, ''))}`);
  if (u.pathname.startsWith('/drive/v3/files')) {
    const q = u.searchParams.get('q') || '';
    if (q.includes("value='root'")) return json({ files: [{ id: 'FOLDER1', name: '名片盒 CardBox' }] });
    if (q.includes("value='data'")) return json({ files: [{ id: 'SHEET1', name: '名片盒資料' }] });
    return json({ files: [] });
  }
  const path = decodeURIComponent(u.pathname.replace('/v4/spreadsheets/SHEET1', ''));
  if (path === '' && method === 'GET') {
    return json({ sheets: Object.entries(sheet.tabs).map(([title, t]) => ({ properties: { title, sheetId: t.sheetId } })) });
  }
  if (path === ':batchUpdate') {
    const replies = [];
    for (const req of body.requests) {
      if (req.addSheet) {
        const title = req.addSheet.properties.title;
        sheet.tabs[title] = { sheetId: 777, rows: [] };
        replies.push({ addSheet: { properties: { title, sheetId: 777 } } });
      } else if (req.deleteDimension) {
        const { sheetId, startIndex, endIndex } = req.deleteDimension.range;
        const tab = Object.values(sheet.tabs).find((t) => t.sheetId === sheetId);
        tab.rows.splice(startIndex, endIndex - startIndex);
        replies.push({});
      } else {
        replies.push({});
      }
    }
    return json({ replies });
  }
  if (path === '/values:batchGet') {
    return json({ valueRanges: u.searchParams.getAll('ranges').map((r) => ({ range: r, values: readRange(r) })) });
  }
  const m = /^\/values\/(.+?)(:append)?$/.exec(path);
  if (m) {
    const a1 = m[1];
    if (m[2]) { // append：加在最後一列後面
      const tab = sheet.tabs[a1.split('!')[0]];
      tab.rows.push([...body.values[0]]);
      return json({});
    }
    if (method === 'PUT') { writeRange(a1, body.values); return json({}); }
    return json({ range: a1, values: readRange(a1) });
  }
  return json({ error: `mock 沒處理：${method} ${path}` }, 500);
};

const { Auth } = await import('../js/auth.js');
Auth.user = { email: 'friend@example.com' };
Auth.ensureToken = async () => 'TOKEN';
const { createGoogleBackend } = await import('../js/google.js');
const { COLUMNS, COMPANY_COLUMNS } = await import('../js/cards.js');

test('舊試算表（v0.2.0）打開後：自動補 Companies 分頁＋兩個分頁的標題列，舊名片照常讀', async () => {
  const backend = createGoogleBackend();
  const cards = await backend.listCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, '小美');
  assert.equal(cards[0].raw_text, '原始文字');
  assert.equal(cards[0].company_id, '');
  assert.ok(sheet.tabs.Companies, '要建出 Companies 分頁');
  assert.deepEqual(sheet.tabs.Cards.rows[0], COLUMNS, 'Cards 標題列要補上 company_id');
  assert.deepEqual(sheet.tabs.Companies.rows[0], COMPANY_COLUMNS);
  assert.deepEqual(sheet.tabs.Cards.rows[1], oldCard, '舊資料那一列不能被動到');
  const ws = JSON.parse(localStorage.getItem('cardbox_ws_friend@example.com'));
  assert.equal(ws.companyTabId, 777);
  assert.deepEqual(await backend.listCompanies(), []);
});

test('第二次打開（新的一次 App）：不會再建分頁、標題一樣就不重寫', async () => {
  calls.length = 0;
  const backend = createGoogleBackend();
  await backend.listCards();
  assert.ok(!calls.some((c) => c.includes(':batchUpdate')), `不該再 batchUpdate：${calls.join(' / ')}`);
  assert.ok(!calls.some((c) => c.startsWith('PUT')), `標題一樣不該重寫：${calls.join(' / ')}`);
});

test('公司檔案：新增、修改、刪除都寫到 Companies 分頁的正確那一列', async () => {
  const backend = createGoogleBackend();
  const a = { id: 'co_a', name: 'SFA', full_name: 'SFA Group', products: [{ name: 'PP', tons: '20' }], domains: 'sfa.com.tw' };
  const b = { id: 'co_b', name: 'GREIF', products: [] };
  await backend.appendCompany(a);
  await backend.appendCompany(b);
  let list = await backend.listCompanies();
  assert.deepEqual(list.map((c) => c.id), ['co_a', 'co_b']);
  assert.deepEqual(list[0].products, [{ name: 'PP', tons: '20' }]);
  await backend.updateCompany({ ...b, relation: '直接用戶' });
  list = await backend.listCompanies();
  assert.equal(list[1].relation, '直接用戶');
  await backend.deleteCompany(a);
  list = await backend.listCompanies();
  assert.deepEqual(list.map((c) => c.id), ['co_b']);
  assert.equal(sheet.tabs.Cards.rows.length, 2, '刪公司不能動到名片分頁');
});

test('名片寫回會帶 company_id（第 21 欄）', async () => {
  const backend = createGoogleBackend();
  const [card] = await backend.listCards();
  await backend.updateCard({ ...card, company_id: 'co_b' });
  assert.equal(sheet.tabs.Cards.rows[1][20], 'co_b');
  const [again] = await backend.listCards();
  assert.equal(again.company_id, 'co_b');
});
