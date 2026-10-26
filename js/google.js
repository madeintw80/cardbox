// Google 雲端後端：照片存 Drive、名片和公司檔案存 Sheets（都在「使用者自己」的雲端硬碟）
// 權限只有 drive.file ＝「只能碰這個 App 自己建立的檔案」，看不到她雲端裡其他東西
// 找檔案靠 appProperties 標記（cardbox=root／data），不靠檔名，使用者改名也找得到
// 試算表兩個分頁：Cards（一張名片一列）、Companies（一家公司一列，v0.3.0 起）

import { Auth } from './auth.js';
import { ROOT_FOLDER_NAME, SHEET_NAME, SHEET_TAB, COMPANY_TAB } from './config.js';
import {
  COLUMNS, rowToCard, cardToRow, COMPANY_COLUMNS, rowToCompany, companyToRow,
} from './cards.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

// 欄位數 → 最後一欄字母（21 欄 → U；超過 26 欄也算得出來）
function colLetter(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// 兩種資料表：分頁名、欄位、列 ↔ 物件的轉換、分頁 id 存在 ws 的哪個欄位
const TABLES = {
  cards: { tab: SHEET_TAB, columns: COLUMNS, toRow: cardToRow, fromRow: rowToCard, tabKey: 'tabId', label: '名片' },
  companies: { tab: COMPANY_TAB, columns: COMPANY_COLUMNS, toRow: companyToRow, fromRow: rowToCompany, tabKey: 'companyTabId', label: '公司' },
};
for (const t of Object.values(TABLES)) t.lastCol = colLetter(t.columns.length);

// 呼叫 Google API 的共用函式：自動帶 token；401（token 剛好過期）就續登後重試一次
async function gfetch(url, options = {}, retried = false) {
  const token = await Auth.ensureToken();
  const resp = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (resp.status === 401 && !retried) {
    Auth.expiresAt = 0; // 強制下一次 ensureToken 去續登
    return gfetch(url, options, true);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`Google API ${resp.status}: ${text.slice(0, 200)}`);
    err.status = resp.status;
    throw err;
  }
  return resp;
}

async function gjson(url, options = {}) {
  const resp = await gfetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return resp.status === 204 ? null : resp.json();
}

// 用 appProperties 找 App 建立過的檔案
async function findByTag(tag) {
  const q = `appProperties has { key='cardbox' and value='${tag}' } and trashed=false`;
  const data = await gjson(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`);
  return data.files?.[0] || null;
}

async function createFile(metadata) {
  return gjson(`${DRIVE}/files?fields=id,name`, { method: 'POST', body: JSON.stringify(metadata) });
}

const range = (sheetRange) => encodeURIComponent(sheetRange);

export function createGoogleBackend() {
  let ws = null; // { folderId, sheetId, tabId, companyTabId }
  let headersChecked = false;
  const wsKey = () => `cardbox_ws_${Auth.user?.email || ''}`;

  // 第一次用：在她的雲端硬碟建「名片盒 CardBox」資料夾＋「名片盒資料」試算表
  // 之後打開：用手機記住的位置；舊版（沒有公司分頁）會自動補上
  async function ensureWorkspace() {
    if (ws) return ws;
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(wsKey()) || 'null');
    } catch {}

    let folderId = saved?.folderId;
    let sheetId = saved?.sheetId;
    if (!folderId || !sheetId) {
      let folder = await findByTag('root');
      if (!folder) {
        folder = await createFile({
          name: ROOT_FOLDER_NAME,
          mimeType: 'application/vnd.google-apps.folder',
          appProperties: { cardbox: 'root' },
        });
      }
      let sheet = await findByTag('data');
      if (!sheet) {
        sheet = await createFile({
          name: SHEET_NAME,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          parents: [folder.id],
          appProperties: { cardbox: 'data' },
        });
        await initSheet(sheet.id);
      }
      folderId = folder.id;
      sheetId = sheet.id;
    }
    if (saved?.folderId === folderId && saved?.sheetId === sheetId && saved.tabId != null && saved.companyTabId != null) {
      ws = saved;
    } else {
      const tabs = await ensureTabs(sheetId);
      ws = { folderId, sheetId, tabId: tabs.cards, companyTabId: tabs.companies };
      localStorage.setItem(wsKey(), JSON.stringify(ws));
    }
    await syncHeaders();
    return ws;
  }

  // 新試算表：第一個分頁改名 Cards、凍結第一列（標題列由 syncHeaders 寫）
  async function initSheet(sheetId) {
    const meta = await gjson(`${SHEETS}/${sheetId}?fields=sheets.properties`);
    const tabId = meta.sheets[0].properties.sheetId;
    await gjson(`${SHEETS}/${sheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: tabId, title: SHEET_TAB, gridProperties: { frozenRowCount: 1 } },
            fields: 'title,gridProperties.frozenRowCount',
          },
        }],
      }),
    });
  }

  // 找出兩個分頁的 id；沒有 Companies 分頁就建一個（v0.2.0 建的試算表只有 Cards）
  async function ensureTabs(sheetId) {
    const meta = await gjson(`${SHEETS}/${sheetId}?fields=sheets.properties`);
    const byTitle = (title) => meta.sheets.find((s) => s.properties.title === title)?.properties.sheetId;
    const cards = byTitle(SHEET_TAB) ?? meta.sheets[0].properties.sheetId;
    let companies = byTitle(COMPANY_TAB);
    if (companies == null) {
      const resp = await gjson(`${SHEETS}/${sheetId}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: COMPANY_TAB, gridProperties: { frozenRowCount: 1 } } } }],
        }),
      });
      companies = resp.replies[0].addSheet.properties.sheetId;
    }
    return { cards, companies };
  }

  // 標題列跟程式的欄位對齊（新版多了欄位時補上標題）；每次打開 App 只檢查一次，一樣就不寫
  async function syncHeaders() {
    if (headersChecked) return;
    const tables = Object.values(TABLES);
    const ranges = tables.map((t) => `ranges=${range(`${t.tab}!A1:${t.lastCol}1`)}`).join('&');
    const data = await gjson(`${SHEETS}/${ws.sheetId}/values:batchGet?${ranges}`);
    for (const [i, t] of tables.entries()) {
      const current = data.valueRanges?.[i]?.values?.[0] || [];
      if (current.join('\u0001') === t.columns.join('\u0001')) continue;
      await gjson(`${SHEETS}/${ws.sheetId}/values/${range(`${t.tab}!A1:${t.lastCol}1`)}?valueInputOption=RAW`, {
        method: 'PUT',
        body: JSON.stringify({ values: [t.columns] }),
      });
    }
    headersChecked = true;
  }

  // 讀整個分頁（第 2 列開始是資料），跳過空白列
  async function readTable(t) {
    const { sheetId } = await ensureWorkspace();
    const data = await gjson(`${SHEETS}/${sheetId}/values/${range(`${t.tab}!A2:${t.lastCol}`)}`);
    return (data.values || []).map((row, i) => t.fromRow(row, i + 2)).filter((x) => x.id);
  }

  // 寫入前重新確認在第幾列（避免另一台手機剛好刪了一列，導致改到別人）
  async function findRowNumber(t, id) {
    const { sheetId } = await ensureWorkspace();
    const data = await gjson(`${SHEETS}/${sheetId}/values/${range(`${t.tab}!A:A`)}`);
    const idx = (data.values || []).findIndex((r) => r[0] === id);
    if (idx < 1) throw new Error(`雲端找不到這筆${t.label}資料（可能已在別的裝置刪除），請下拉重新整理`);
    return idx + 1; // Sheet 列號從 1 開始
  }

  async function appendRow(t, obj) {
    const { sheetId } = await ensureWorkspace();
    await gjson(
      `${SHEETS}/${sheetId}/values/${range(`${t.tab}!A:${t.lastCol}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values: [t.toRow(obj)] }) },
    );
  }

  async function updateRow(t, obj) {
    const { sheetId } = await ensureWorkspace();
    const rowNum = await findRowNumber(t, obj.id);
    await gjson(`${SHEETS}/${sheetId}/values/${range(`${t.tab}!A${rowNum}:${t.lastCol}${rowNum}`)}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values: [t.toRow(obj)] }),
    });
  }

  async function deleteRow(t, obj) {
    const current = await ensureWorkspace();
    const rowNum = await findRowNumber(t, obj.id);
    await gjson(`${SHEETS}/${current.sheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: { sheetId: current[t.tabKey], dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum },
          },
        }],
      }),
    });
  }

  // 工作區設定失效（例如她把資料夾丟進垃圾桶）→ 清掉記憶重新找／建
  function resetWorkspace() {
    ws = null;
    headersChecked = false;
    localStorage.removeItem(wsKey());
  }

  async function listWithRecovery(t) {
    try {
      return await readTable(t);
    } catch (err) {
      if (err.status !== 404) throw err;
      resetWorkspace();
      return readTable(t);
    }
  }

  return {
    name: 'google',

    listCards: () => listWithRecovery(TABLES.cards),
    appendCard: (card) => appendRow(TABLES.cards, card),
    updateCard: (card) => updateRow(TABLES.cards, card),

    async deleteCard(card) {
      await deleteRow(TABLES.cards, card);
      // 照片丟進她的雲端垃圾桶（30 天內還救得回來，不是永久刪除）
      for (const photoId of card.photos || []) {
        try {
          await gjson(`${DRIVE}/files/${photoId}`, { method: 'PATCH', body: JSON.stringify({ trashed: true }) });
        } catch (err) {
          console.warn('trash photo failed', photoId, err);
        }
      }
    },

    listCompanies: () => listWithRecovery(TABLES.companies),
    appendCompany: (co) => appendRow(TABLES.companies, co),
    updateCompany: (co) => updateRow(TABLES.companies, co),
    deleteCompany: (co) => deleteRow(TABLES.companies, co),

    async uploadPhoto(blob, fileName) {
      const { folderId } = await ensureWorkspace();
      const metadata = { name: fileName, parents: [folderId], appProperties: { cardbox: 'photo' } };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', blob, fileName);
      const resp = await gfetch(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', body: form });
      const data = await resp.json();
      return data.id;
    },

    async getPhoto(fileId) {
      const resp = await gfetch(`${DRIVE}/files/${fileId}?alt=media`);
      return resp.blob();
    },

    async links() {
      const { folderId, sheetId } = await ensureWorkspace();
      return {
        sheet: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
        folder: `https://drive.google.com/drive/folders/${folderId}`,
      };
    },

    resetWorkspace,
  };
}
