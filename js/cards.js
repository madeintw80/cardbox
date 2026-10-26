// 名片資料的「純邏輯」：欄位定義、Sheet 列 ↔ 物件、搜尋、正反面合併、vCard
// 這個檔案不碰網路也不碰畫面，所以可以單獨測試（tests/cards.test.html）

// Sheet 欄位順序（第一列是標題）。新增欄位只能「加在最後面」，舊資料才不會錯位
export const COLUMNS = [
  'id',          // 名片編號 c_xxxx
  'created_at',  // 建立時間 ISO
  'updated_at',  // 最後修改時間 ISO
  'name',        // 姓名（主要語言）
  'name_alt',    // 另一種語言的姓名（例：英文名）
  'company',     // 公司
  'department',  // 部門
  'title',       // 職稱
  'mobile',      // 手機
  'phone',       // 市話（含分機）
  'fax',         // 傳真
  'email',       // Email（多個用 ", " 隔開）
  'website',     // 網站
  'address',     // 地址
  'social',      // LINE／WeChat／IG 等
  'note',        // 自己的備註（在哪認識…）
  'tags',        // 標籤（用 ", " 隔開）
  'photos',      // 照片的 Drive 檔案 ID（JSON 陣列，第一張是正面）
  'status',      // ok｜error
  'raw_text',    // 名片上全部文字（給搜尋和對照用）
  'company_id',  // 屬於哪個公司檔案（Companies 分頁的 id；空白＝不歸屬）
  'nationality', // 國籍（她自己選；AI 不猜——名片只看得出公司在哪，看不出人是哪國人）
];

// 畫面上可編輯的欄位（含中文標籤）；順序＝編輯表單的順序
export const EDITABLE_FIELDS = [
  ['name', '姓名'],
  ['name_alt', '其他語言姓名'],
  ['nationality', '國籍'],
  ['company', '公司'],
  ['department', '部門'],
  ['title', '職稱'],
  ['mobile', '手機'],
  ['phone', '電話'],
  ['fax', '傳真'],
  ['email', 'Email'],
  ['website', '網站'],
  ['address', '地址'],
  ['social', 'LINE／社群'],
  ['note', '備註'],
  ['tags', '標籤'],
];

// AI 辨識結果裡，會被寫進名片的欄位
export const OCR_FIELDS = [
  'name', 'name_alt', 'company', 'department', 'title',
  'mobile', 'phone', 'fax', 'email', 'website', 'address', 'social',
];

// 產生名片編號：c_ + 時間(36進位) + 亂數，幾乎不可能重複
export function newCardId() {
  const rand = Math.random().toString(36).slice(2, 7);
  return `c_${Date.now().toString(36)}${rand}`;
}

// Sheet 的一列（陣列）→ 名片物件
export function rowToCard(row, rowNumber) {
  const card = {};
  COLUMNS.forEach((col, i) => { card[col] = (row[i] ?? '').toString(); });
  card.photos = parsePhotos(card.photos);
  card._row = rowNumber; // 記住在第幾列（只是參考，寫入前會重新確認）
  return card;
}

// 名片物件 → Sheet 的一列（陣列）
export function cardToRow(card) {
  return COLUMNS.map((col) => {
    if (col === 'photos') return JSON.stringify(card.photos || []);
    const v = card[col];
    return v == null ? '' : String(v);
  });
}

function parsePhotos(text) {
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  } catch {
    return [];
  }
}

// 把 AI 回傳的欄位清乾淨（去頭尾空白、把 null 變空字串）
export function cleanOcrResult(result) {
  const out = {};
  for (const f of OCR_FIELDS) {
    out[f] = tidy(result?.[f]);
  }
  out.raw_text = (result?.raw_text ?? '').toString().trim().slice(0, 3000);
  out.is_business_card = result?.is_business_card !== false;
  // 辨識主機順便查的「公司檔案草稿」（舊版主機沒有這幾欄 → 空白）
  out.auto = {};
  for (const [field, key] of Object.entries(AUTO_FIELD_MAP)) out.auto[field] = tidy(result?.[key]).slice(0, 200);
  return out;
}

function tidy(v) {
  if (v == null) return '';
  return String(v).replace(/\s+\n/g, '\n').trim();
}

// 用辨識結果建立一張新名片
export function makeCardFromOcr(ocr, photoId, now = new Date()) {
  const iso = now.toISOString();
  const card = {
    id: newCardId(),
    created_at: iso,
    updated_at: iso,
    note: '',
    tags: '',
    photos: photoId ? [photoId] : [],
    status: 'ok',
    company_id: '',
    nationality: '',
  };
  for (const f of OCR_FIELDS) card[f] = ocr[f] || '';
  card.raw_text = ocr.raw_text || '';
  return card;
}

// ---- 正反面自動合併 ----
// 只比「手機號碼」和「Email」：這兩個一樣就幾乎確定是同一個人（姓名可能一面中文一面英文）

// 電話只留數字；台灣手機 +886 9xx → 09xx，讓兩面格式不同也能比
export function normalizePhone(text) {
  let digits = (text || '').replace(/\D/g, '');
  if (digits.startsWith('8869')) digits = '0' + digits.slice(3);
  return digits;
}

function emailSet(text) {
  return new Set(
    (text || '').toLowerCase().split(/[,;\s]+/).filter((e) => e.includes('@')),
  );
}

// 兩張名片是不是同一個人（正反面）
export function isSamePerson(a, b) {
  const ma = normalizePhone(a.mobile);
  const mb = normalizePhone(b.mobile);
  if (ma.length >= 8 && ma === mb) return true;
  const ea = emailSet(a.email);
  for (const e of emailSet(b.email)) {
    if (ea.has(e)) return true;
  }
  return false;
}

// 有沒有中日韓文字（用來判斷「中文面」）
export function hasCjk(text) {
  return /[㐀-鿿豈-﫿぀-ヿ가-힯]/.test(text || '');
}

// 這些欄位如果一面是中文、一面是英文，以中文為主（台灣使用者看中文比較直覺）
const PREFER_CJK_FIELDS = ['company', 'department', 'title', 'address'];

// 把另一面的資料併進來：
//  - 空的欄位才補，已經有值的不動
//  - 例外：現在是英文、另一面是中文 → 換成中文（姓名的話，英文移到 name_alt）
//  - 中文面的照片排第一張（正面）
// 為什麼要這樣：兩面是同時辨識的，英文面可能先辨識完、先建檔
export function mergeBackSide(card, ocr, photoId, now = new Date()) {
  const merged = { ...card, photos: [...(card.photos || [])] };
  const incomingIsCjkSide = hasCjk(ocr.name) && !hasCjk(merged.name);

  for (const f of OCR_FIELDS) {
    if (f === 'name' || f === 'name_alt') continue;
    if (!ocr[f]) continue;
    if (!merged[f]) merged[f] = ocr[f];
    else if (PREFER_CJK_FIELDS.includes(f) && hasCjk(ocr[f]) && !hasCjk(merged[f])) merged[f] = ocr[f];
  }

  if (ocr.name && ocr.name !== merged.name) {
    if (!merged.name) {
      merged.name = ocr.name;
    } else if (incomingIsCjkSide) {
      merged.name_alt = merged.name_alt || merged.name;
      merged.name = ocr.name;
    } else if (!merged.name_alt) {
      merged.name_alt = ocr.name;
    }
  }
  if (!merged.name_alt && ocr.name_alt && ocr.name_alt !== merged.name) merged.name_alt = ocr.name_alt;

  if (ocr.raw_text) {
    merged.raw_text = [merged.raw_text, ocr.raw_text].filter(Boolean).join('\n---\n').slice(0, 6000);
  }
  if (photoId && !merged.photos.includes(photoId)) {
    if (incomingIsCjkSide) merged.photos.unshift(photoId);
    else merged.photos.push(photoId);
  }
  merged.updated_at = now.toISOString();
  return merged;
}

// ---- 搜尋與排序 ----

// 搜尋用的文字：全部欄位串起來、轉小寫；電話另外加「只有數字」的版本，打 0912345 也找得到
// 有公司檔案的話，公司全名、在做什麼、產業、產品也一起搜（打「鋼桶」找得到包裝廠的人）
function searchText(card, company) {
  const parts = [
    card.name, card.name_alt, card.company, card.department, card.title,
    card.mobile, card.phone, card.fax, card.email, card.website,
    card.address, card.social, card.note, card.tags, card.raw_text, card.nationality,
    normalizePhone(card.mobile), normalizePhone(card.phone),
  ];
  if (company) parts.push(companySearchText(company));
  return parts.join(' ').toLowerCase();
}

function matchesQuery(text, words) {
  return words.every((w) => text.includes(w) || text.includes(w.replace(/\D/g, '') || '\u0000'));
}

function queryWords(query) {
  return (query || '').toLowerCase().split(/\s+/).filter(Boolean);
}

// 關鍵字可以用空白分開打多個，全部都要符合（例：「台積 經理」）
// companyOf：名片 → 它的公司檔案（可省略）
export function searchCards(cards, query, companyOf = () => null) {
  const words = queryWords(query);
  if (!words.length) return cards;
  return cards.filter((c) => matchesQuery(searchText(c, companyOf(c)), words));
}

const collator = new Intl.Collator('zh-Hant-TW');

// companyName：名片 → 依公司排序時用的名字（有公司檔案就用檔案的簡稱，同一家的才會排在一起）
export function sortCards(cards, mode, companyName = (c) => c.company) {
  const list = [...cards];
  if (mode === 'name') {
    list.sort((a, b) => collator.compare(a.name || a.name_alt || '', b.name || b.name_alt || ''));
  } else if (mode === 'company') {
    list.sort((a, b) => collator.compare(companyName(a) || '￿', companyName(b) || '￿')
      || collator.compare(a.name || '', b.name || ''));
  } else {
    list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }
  return list;
}

// 卡片列表顯示用的「頭像字」：取姓名（沒有就用公司）的第一個字
export function avatarText(card) {
  const n = (card.name || card.name_alt || card.company || '?').trim();
  return n ? Array.from(n)[0].toUpperCase() : '?';
}

// ---- vCard（加入手機通訊錄）----

function vEscape(text) {
  return (text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// company：這張名片的公司檔案（可省略）；有全名就寫進備註，通訊錄裡的「公司」照名片上印的
export function cardToVCard(card, company = null) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  const name = card.name || card.name_alt || card.company || '未命名';
  lines.push(`FN:${vEscape(name)}`);
  lines.push(`N:${vEscape(name)};;;;`);
  if (card.name && card.name_alt) lines.push(`NICKNAME:${vEscape(card.name_alt)}`);
  if (card.company || card.department) {
    lines.push(`ORG:${vEscape(card.company)}${card.department ? ';' + vEscape(card.department) : ''}`);
  }
  if (card.title) lines.push(`TITLE:${vEscape(card.title)}`);
  for (const m of splitMulti(card.mobile)) lines.push(`TEL;TYPE=CELL:${m}`);
  for (const p of splitMulti(card.phone)) lines.push(`TEL;TYPE=WORK,VOICE:${p}`);
  for (const f of splitMulti(card.fax)) lines.push(`TEL;TYPE=WORK,FAX:${f}`);
  for (const e of splitMulti(card.email)) lines.push(`EMAIL;TYPE=INTERNET,WORK:${e}`);
  if (card.website) lines.push(`URL:${vEscape(withScheme(card.website.split(/[,\s]+/)[0]))}`);
  if (card.address) lines.push(`ADR;TYPE=WORK:;;${vEscape(card.address)};;;;`);
  const fullName = cleanFullName(company?.full_name);
  const notes = [
    card.note,
    card.nationality && `國籍：${card.nationality}`,
    fullName && fullName !== card.company && `公司全名：${fullName}`,
    card.social && `社群：${card.social}`,
    card.tags && `標籤：${card.tags}`,
  ].filter(Boolean).join('\n');
  if (notes) lines.push(`NOTE:${vEscape(notes)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

export function cardsToVCard(cards, companyOf = () => null) {
  return cards.map((c) => cardToVCard(c, companyOf(c))).join('\r\n') + '\r\n';
}

// 一格裡有多個號碼（用逗號、斜線、換行隔開）→ 拆開
export function splitMulti(text) {
  return (text || '').split(/[,;\/\n]+/).map((s) => s.trim()).filter(Boolean);
}

export function withScheme(url) {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// 電話撥號用：去掉分機和空白，只留 + 和數字
export function telHref(text) {
  const main = (text || '').split(/(?:#|ext\.?|分機|轉)/i)[0];
  return 'tel:' + main.replace(/[^\d+]/g, '');
}

// ======================= 公司檔案 =======================
// 一家公司一列（Sheet 的 Companies 分頁）；名片用 company_id 連過來。
// 公司的事（在做什麼、需求產品…）寫在這裡一次，同公司 50 張名片都看得到。

// Companies 分頁欄位順序。跟名片一樣：新增欄位只能「加在最後面」
export const COMPANY_COLUMNS = [
  'id',              // 公司編號 co_xxxx
  'created_at',
  'updated_at',
  'name',            // 公司簡稱（名片上印的，例：SFA）
  'full_name',       // 公司全名（AI 查的、可以改；AI 沒把握時結尾有「（待確認）」）
  'about',           // 在做什麼
  'industry',        // 產業類別
  'relation',        // 關係（貿易商／直接用戶…）
  'region',          // 地區
  'sales_type',      // 內外銷
  'material_source', // 材料來源
  'products',        // 需求產品（JSON 陣列：[{ name: 產品, tons: 每月噸數 }]）
  'website',         // 網站
  'domains',         // 公司信箱網域（用 ", " 隔開；新名片靠這個自動歸到同一家）
  'note',            // 備註
  'tags',            // 標籤
  'auto_fields',     // 哪些欄位是 AI 自動產生、還沒被人改過（例："full_name,about"），畫面上會標「自動產生」
];

// 公司編輯頁的欄位（含中文標籤）；products 另外處理
export const COMPANY_FIELDS = [
  ['name', '公司簡稱'],
  ['full_name', '公司全名'],
  ['about', '在做什麼'],
  ['relation', '關係'],
  ['industry', '產業類別'],
  ['region', '地區'],
  ['sales_type', '內外銷'],
  ['material_source', '材料來源'],
  ['website', '網站'],
  ['domains', '公司信箱網域'],
  ['note', '備註'],
  ['tags', '標籤'],
];

// 下拉選單欄位：選單內容＝預設值＋所有公司填過的值（打過一次的新值，下次就會出現在選單裡）
export const PICK_FIELDS = ['relation', 'industry', 'region', 'sales_type', 'material_source'];
export const PICK_DEFAULTS = {
  relation: ['貿易商', '直接用戶'],
  sales_type: ['內銷', '外銷', '內外銷'],
};
export const PRODUCT_FIELD = 'product'; // 「需求產品」的產品名稱也是下拉選單（選單整理頁用這個代號）
// 名片（個人）上的下拉選單欄位：選單內容＝所有名片填過的值
export const CARD_PICK_FIELDS = ['nationality'];

// AI 草稿：公司檔案欄位 ← 辨識主機回傳的欄位
export const AUTO_FIELD_MAP = {
  full_name: 'company_full',
  about: 'company_about',
  industry: 'company_industry',
  region: 'company_region',
};

export function newCompanyId() {
  const rand = Math.random().toString(36).slice(2, 7);
  return `co_${Date.now().toString(36)}${rand}`;
}

export function rowToCompany(row, rowNumber) {
  const co = {};
  COMPANY_COLUMNS.forEach((col, i) => { co[col] = (row[i] ?? '').toString(); });
  co.products = parseProducts(co.products);
  co._row = rowNumber;
  return co;
}

export function companyToRow(co) {
  return COMPANY_COLUMNS.map((col) => {
    if (col === 'products') return JSON.stringify(cleanProducts(co.products));
    const v = co[col];
    return v == null ? '' : String(v);
  });
}

function parseProducts(text) {
  if (!text) return [];
  try {
    return cleanProducts(JSON.parse(text));
  } catch {
    return [];
  }
}

// 產品清單整理：去掉空白列；噸數存成字串（她可能打「約 20」，不硬轉數字）
export function cleanProducts(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => ({ name: String(p?.name ?? '').trim(), tons: String(p?.tons ?? '').trim() }))
    .filter((p) => p.name || p.tons);
}

// 每月總噸數（只加得起來的數字；有一筆不是數字就標 skipped，畫面提醒有沒算到的）
export function totalTons(products) {
  let sum = 0;
  let skipped = false;
  for (const p of products || []) {
    const n = parseFloat(String(p.tons).replace(/[^\d.]/g, ''));
    if (Number.isFinite(n)) sum += n; else if (p.tons) skipped = true;
  }
  return { sum: Math.round(sum * 100) / 100, skipped };
}

// 全名去掉「（待確認）」
export function cleanFullName(name) {
  return (name || '').replace(/（待確認）$/, '').trim();
}

export function companyDisplayName(co) {
  return co ? (co.name || cleanFullName(co.full_name) || '（沒有名字的公司）') : '';
}

export function autoFieldSet(co) {
  return new Set((co?.auto_fields || '').split(',').map((s) => s.trim()).filter(Boolean));
}

function companySearchText(co) {
  return [
    co.name, co.full_name, co.about, co.industry, co.relation, co.region, co.sales_type,
    co.material_source, co.website, co.domains, co.note, co.tags,
    ...(co.products || []).map((p) => p.name),
  ].join(' ');
}

export function searchCompanies(companies, query) {
  const words = queryWords(query);
  if (!words.length) return companies;
  return companies.filter((co) => matchesQuery(companySearchText(co).toLowerCase(), words));
}

export function sortCompanies(companies) {
  return [...companies].sort((a, b) => collator.compare(companyDisplayName(a), companyDisplayName(b)));
}

// ---- 公司信箱網域（跟辨識主機 company_profile.py 同一套規則）----

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.com.tw', 'yahoo.co.jp', 'ymail.com',
  'hotmail.com', 'hotmail.com.tw', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com',
  'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'mail.com',
  'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com', 'naver.com', 'daum.net', 'hanmail.net',
  'pchome.com.tw', 'kimo.com', 'seed.net.tw', 'hinet.net', 'so-net.net.tw', 'url.com.tw',
]);
const SOCIAL_DOMAINS = new Set([
  'facebook.com', 'fb.com', 'instagram.com', 'line.me', 'linkedin.com', 'twitter.com', 'x.com',
  'youtube.com', 'threads.net', 'tiktok.com', 'wechat.com', 'weibo.com', 'linktr.ee',
]);
const SHARED_SECOND_LEVEL = new Set(['com', 'co', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'idv', 'ltd']);

// com.tw、co.jp 這種國家共用的尾巴（或只剩一段）→ true
function isSharedSuffix(domain) {
  const labels = domain.split('.');
  return labels.length < 2 || (labels.length === 2 && labels[1].length === 2 && SHARED_SECOND_LEVEL.has(labels[0]));
}

function isFreeOrSocial(domain) {
  for (const blocked of [...FREE_MAIL_DOMAINS, ...SOCIAL_DOMAINS]) {
    if (domain === blocked || domain.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

// sales.sfa.com.tw → sfa.com.tw：同公司不同部門的信箱歸成同一個網域
export function baseDomain(host) {
  let h = (host || '').trim().replace(/^\.+|\.+$/g, '').toLowerCase().replace(/^www\./, '');
  while (h.split('.').length >= 3 && !isSharedSuffix(h.slice(h.indexOf('.') + 1))) {
    h = h.slice(h.indexOf('.') + 1);
  }
  return h;
}

// 名片上的公司網域（email 優先，再看網址；免費信箱、社群網站不算）
export function cardDomains(card) {
  const hosts = [];
  for (const m of (card.email || '').matchAll(/[\w.+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) hosts.push(m[1]);
  for (const piece of (card.website || '').split(/[,\s;]+/)) {
    if (!piece || piece.includes('@')) continue;
    try {
      hosts.push(new URL(withScheme(piece)).hostname);
    } catch {}
  }
  const out = [];
  for (const host of hosts) {
    const d = baseDomain(host);
    if (!d.includes('.') || isSharedSuffix(d) || isFreeOrSocial(d) || out.includes(d)) continue;
    out.push(d);
  }
  return out;
}

export function splitList(text) {
  return (text || '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
}

// 公司名比對用的「骨幹」：去掉股份有限公司／Inc.／Co., Ltd. 這類尾巴、空白、標點、大小寫
export function companyNameKey(name) {
  let s = cleanFullName(name).toLowerCase();
  s = s.replace(/股份有限公司|有限責任公司|有限公司|株式会社|株式會社/g, '');
  s = s.replace(/\b(inc|ltd|llc|llp|plc|corp|corporation|limited|co|company|gmbh|s\.p\.a|s\.r\.l|pte|pty|group|holdings?)\b\.?/g, '');
  s = s.replace(/公司$/, '');
  return s.replace(/[\s\p{P}\p{S}]+/gu, '');
}

// 名片 → 該歸到哪家公司：先比公司信箱網域（最準），沒有才比公司名（簡稱或全名對得上都算）
export function matchCompany(card, companies) {
  const domains = cardDomains(card);
  if (domains.length) {
    const hit = companies.find((co) => splitList(co.domains).some((d) => domains.includes(d)));
    if (hit) return hit;
  }
  const key = companyNameKey(card.company);
  if (!key) return null;
  return companies.find((co) => companyNameKey(co.name) === key || companyNameKey(co.full_name) === key) || null;
}

// 用名片（＋AI 草稿）補公司檔案「還空著」的欄位；她填過或改過的不動
// 回傳 { company: 新的公司物件, changed: 有沒有變 }
export function fillCompanyFromCard(company, card, auto = {}, now = new Date()) {
  const co = { ...company, products: [...(company.products || [])] };
  const autoSet = autoFieldSet(co);
  let changed = false;
  for (const field of Object.keys(AUTO_FIELD_MAP)) {
    const value = (auto[field] || '').trim();
    if (!value || co[field]) continue;
    if (field === 'full_name' && cleanFullName(value) === co.name) continue; // 全名跟簡稱一樣就不用存
    co[field] = value;
    autoSet.add(field);
    changed = true;
  }
  if (!co.website && card.website) {
    co.website = splitList(card.website)[0] || '';
    changed = changed || !!co.website;
  }
  const domains = splitList(co.domains);
  for (const d of cardDomains(card)) {
    if (!domains.includes(d)) { domains.push(d); changed = true; }
  }
  co.domains = domains.join(', ');
  co.auto_fields = [...autoSet].join(',');
  if (changed) co.updated_at = now.toISOString();
  return { company: co, changed };
}

// 名片上的公司還沒有檔案 → 建一個（沒有公司名也沒有公司網域就不建，回 null）
export function makeCompanyFromCard(card, auto = {}, now = new Date()) {
  const domains = cardDomains(card);
  const name = (card.company || '').trim() || cleanFullName(auto.full_name) || domains[0] || '';
  if (!name) return null;
  const iso = now.toISOString();
  const blank = {
    id: newCompanyId(), created_at: iso, updated_at: iso, name,
    full_name: '', about: '', industry: '', relation: '', region: '', sales_type: '', material_source: '',
    products: [], website: '', domains: '', note: '', tags: '', auto_fields: '',
  };
  const { company } = fillCompanyFromCard(blank, card, auto, now);
  company.updated_at = iso;
  return company;
}

// 下拉選單內容：預設值在前，再來是公司填過的值（用得多的排前面）
// field 是 PICK_FIELDS 之一，或 PRODUCT_FIELD（需求產品的產品名稱）
export function pickOptions(companies, field) {
  const counts = optionCounts(companies, field);
  const defaults = PICK_DEFAULTS[field] || [];
  const others = [...counts.keys()].filter((v) => !defaults.includes(v))
    .sort((a, b) => (counts.get(b) - counts.get(a)) || collator.compare(a, b));
  return [...defaults, ...others];
}

// 每個選項被幾家公司用到（選單整理頁顯示用）
export function optionCounts(companies, field) {
  const counts = new Map();
  for (const co of companies) {
    const values = field === PRODUCT_FIELD
      ? [...new Set((co.products || []).map((p) => p.name).filter(Boolean))]
      : [co[field]].filter(Boolean);
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  }
  return counts;
}

// 選項改名（全部公司一起改；改成空白＝從這些公司清掉）。回傳有變的公司（呼叫的人負責存）
export function renameOption(companies, field, from, to, now = new Date()) {
  const target = (to || '').trim();
  const changed = [];
  for (const co of companies) {
    let updated = null;
    if (field === PRODUCT_FIELD) {
      if ((co.products || []).some((p) => p.name === from)) {
        updated = { ...co, products: cleanProducts(co.products.map((p) => (p.name === from ? { ...p, name: target } : p))) };
      }
    } else if (co[field] === from) {
      updated = { ...co, [field]: target };
    }
    if (updated) {
      updated.updated_at = now.toISOString();
      changed.push(updated);
    }
  }
  return changed;
}

// ---- 自訂分組排序（清單上「＋」新增的排序）----

// 可以拿來分組的欄位：[代號, 中文, 來源（名片 card／公司檔案 company）]
export const GROUP_FIELDS = [
  ['relation', '關係', 'company'],
  ['industry', '產業類別', 'company'],
  ['region', '地區', 'company'],
  ['sales_type', '內外銷', 'company'],
  ['material_source', '材料來源', 'company'],
  [PRODUCT_FIELD, '需求產品', 'company'],
  ['nationality', '國籍', 'card'],
  ['tags', '標籤', 'card'],
  ['title', '職稱', 'card'],
  ['department', '部門', 'card'],
];

// 一張名片在某個欄位底下屬於哪幾組（標籤、需求產品可能好幾組，名片會出現在每一組）
export function groupValues(card, field, company) {
  if (field === PRODUCT_FIELD) return [...new Set((company?.products || []).map((p) => p.name).filter(Boolean))];
  if (field === 'tags') return splitList(card.tags);
  const def = GROUP_FIELDS.find(([key]) => key === field);
  const source = def?.[2] === 'company' ? company : card;
  const value = (source?.[field] || '').trim();
  return value ? [value] : [];
}

export const UNGROUPED = '（未填）';

// 依欄位分組 → [[組名, 名片陣列], …]；組名照筆畫排，「未填」放最後，組內照姓名排
export function groupCards(cards, field, companyOf = () => null) {
  const groups = new Map();
  for (const card of cards) {
    const values = groupValues(card, field, companyOf(card));
    for (const v of values.length ? values : [UNGROUPED]) {
      if (!groups.has(v)) groups.set(v, []);
      groups.get(v).push(card);
    }
  }
  const names = [...groups.keys()].sort((a, b) =>
    (a === UNGROUPED) - (b === UNGROUPED) || collator.compare(a, b));
  return names.map((n) => [n, sortCards(groups.get(n), 'name')]);
}

// ---- 日曆 ----

// ISO 時間 → 手機當地的日期 "2026-10-27"（日曆分組用；不能直接切 ISO 字串，那是 UTC，晚上 8 點後會算到隔天）
export function localDayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 某個月（"2026-10"）的月曆格子：前面補空格讓 1 號落在正確的星期（星期日開頭）
export function monthGrid(month) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const cells = Array(first.getDay()).fill(null);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  return cells;
}

export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
