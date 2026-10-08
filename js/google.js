// Google 雲端後端：照片存 Drive、名片資料存 Sheets（都在「使用者自己」的雲端硬碟）
// 權限只有 drive.file ＝「只能碰這個 App 自己建立的檔案」，看不到她雲端裡其他東西
// 找檔案靠 appProperties 標記（cardbox=root／data），不靠檔名，使用者改名也找得到

import { Auth } from './auth.js';
import { ROOT_FOLDER_NAME, SHEET_NAME, SHEET_TAB } from './config.js';
import { COLUMNS, rowToCard, cardToRow } from './cards.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

// 欄位數 → 最後一欄字母（20 欄 → T）
const LAST_COL = String.fromCharCode(64 + COLUMNS.length);

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

export function createGoogleBackend() {
  let ws = null; // { folderId, sheetId, tabId }
  const wsKey = () => `cardbox_ws_${Auth.user?.email || ''}`;

  // 第一次用：在她的雲端硬碟建「名片盒 CardBox」資料夾＋「名片盒資料」試算表
  async function ensureWorkspace() {
    if (ws) return ws;
    try {
      const saved = JSON.parse(localStorage.getItem(wsKey()) || 'null');
      if (saved?.folderId && saved?.sheetId) { ws = saved; return ws; }
    } catch {}

    let folder = await findByTag('root');
    if (!folder) {
      folder = await createFile({
        name: ROOT_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: { cardbox: 'root' },
      });
    }
    let sheet = await findByTag('data');
    let tabId;
    if (!sheet) {
      sheet = await createFile({
        name: SHEET_NAME,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        parents: [folder.id],
        appProperties: { cardbox: 'data' },
      });
      tabId = await initSheet(sheet.id);
    } else {
      tabId = await getTabId(sheet.id);
    }
    ws = { folderId: folder.id, sheetId: sheet.id, tabId };
    localStorage.setItem(wsKey(), JSON.stringify(ws));
    return ws;
  }

  // 新試算表：第一個分頁改名 Cards、寫標題列、凍結第一列
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
    await gjson(
      `${SHEETS}/${sheetId}/values/${encodeURIComponent(`${SHEET_TAB}!A1:${LAST_COL}1`)}?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ values: [COLUMNS] }) },
    );
    return tabId;
  }

  async function getTabId(sheetId) {
    const meta = await gjson(`${SHEETS}/${sheetId}?fields=sheets.properties`);
    const tab = meta.sheets.find((s) => s.properties.title === SHEET_TAB) || meta.sheets[0];
    return tab.properties.sheetId;
  }

  // 讀整張表（第 2 列開始是資料）
  async function readRows() {
    const { sheetId } = await ensureWorkspace();
    const range = `${SHEET_TAB}!A2:${LAST_COL}`;
    const data = await gjson(`${SHEETS}/${sheetId}/values/${encodeURIComponent(range)}`);
    return data.values || [];
  }

  // 寫入前重新確認名片在第幾列（避免另一台手機剛好刪了一列，導致改到別人）
  async function findRowNumber(cardId) {
    const { sheetId } = await ensureWorkspace();
    const data = await gjson(`${SHEETS}/${sheetId}/values/${encodeURIComponent(`${SHEET_TAB}!A:A`)}`);
    const idx = (data.values || []).findIndex((r) => r[0] === cardId);
    if (idx < 1) throw new Error('雲端找不到這張名片（可能已在別的裝置刪除），請下拉重新整理');
    return idx + 1; // Sheet 列號從 1 開始
  }

  // 工作區設定失效（例如她把資料夾丟進垃圾桶）→ 清掉記憶重新找／建
  function resetWorkspace() {
    ws = null;
    localStorage.removeItem(wsKey());
  }

  return {
    name: 'google',

    async listCards() {
      let rows;
      try {
        rows = await readRows();
      } catch (err) {
        if (err.status === 404) { resetWorkspace(); rows = await readRows(); } else throw err;
      }
      return rows
        .map((row, i) => rowToCard(row, i + 2))
        .filter((c) => c.id); // 跳過空白列
    },

    async appendCard(card) {
      const { sheetId } = await ensureWorkspace();
      const range = `${SHEET_TAB}!A:${LAST_COL}`;
      await gjson(
        `${SHEETS}/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { method: 'POST', body: JSON.stringify({ values: [cardToRow(card)] }) },
      );
    },

    async updateCard(card) {
      const { sheetId } = await ensureWorkspace();
      const rowNum = await findRowNumber(card.id);
      const range = `${SHEET_TAB}!A${rowNum}:${LAST_COL}${rowNum}`;
      await gjson(`${SHEETS}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
        method: 'PUT',
        body: JSON.stringify({ values: [cardToRow(card)] }),
      });
    },

    async deleteCard(card) {
      const { sheetId, tabId } = await ensureWorkspace();
      const rowNum = await findRowNumber(card.id);
      await gjson(`${SHEETS}/${sheetId}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: [{
            deleteDimension: {
              range: { sheetId: tabId, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum },
            },
          }],
        }),
      });
      // 照片丟進她的雲端垃圾桶（30 天內還救得回來，不是永久刪除）
      for (const photoId of card.photos || []) {
        try {
          await gjson(`${DRIVE}/files/${photoId}`, { method: 'PATCH', body: JSON.stringify({ trashed: true }) });
        } catch (err) {
          console.warn('trash photo failed', photoId, err);
        }
      }
    },

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
