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
];

// 畫面上可編輯的欄位（含中文標籤）；順序＝編輯表單的順序
export const EDITABLE_FIELDS = [
  ['name', '姓名'],
  ['name_alt', '其他語言姓名'],
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
function searchText(card) {
  const parts = [
    card.name, card.name_alt, card.company, card.department, card.title,
    card.mobile, card.phone, card.fax, card.email, card.website,
    card.address, card.social, card.note, card.tags, card.raw_text,
    normalizePhone(card.mobile), normalizePhone(card.phone),
  ];
  return parts.join(' ').toLowerCase();
}

// 關鍵字可以用空白分開打多個，全部都要符合（例：「台積 經理」）
export function searchCards(cards, query) {
  const words = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return cards;
  return cards.filter((c) => {
    const text = searchText(c);
    return words.every((w) => text.includes(w) || text.includes(w.replace(/\D/g, '') || '\u0000'));
  });
}

const collator = new Intl.Collator('zh-Hant-TW');

export function sortCards(cards, mode) {
  const list = [...cards];
  if (mode === 'name') {
    list.sort((a, b) => collator.compare(a.name || a.name_alt || '', b.name || b.name_alt || ''));
  } else if (mode === 'company') {
    list.sort((a, b) => collator.compare(a.company || '￿', b.company || '￿')
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

export function cardToVCard(card) {
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
  const notes = [card.note, card.social && `社群：${card.social}`, card.tags && `標籤：${card.tags}`]
    .filter(Boolean).join('\n');
  if (notes) lines.push(`NOTE:${vEscape(notes)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

export function cardsToVCard(cards) {
  return cards.map(cardToVCard).join('\r\n') + '\r\n';
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
