// 手機本機資料庫（IndexedDB）：放「還沒辨識完的照片」和「縮圖快取」
// 為什麼要存本機：一次上傳 50 張要好幾分鐘，中途關掉 App 也不會弄丟，下次打開會接著做

const DB_NAME = 'cardbox';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'qid' });
      if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// 通用小工具：開一個交易、做一件事、等它完成
async function run(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = fn(store);
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---- 待辨識佇列 ----
export const queueDb = {
  put: (item) => run('queue', 'readwrite', (s) => s.put(item)),
  remove: (qid) => run('queue', 'readwrite', (s) => s.delete(qid)),
  all: async () => {
    const items = (await run('queue', 'readonly', (s) => s.getAll())) || [];
    return items.sort((a, b) => a.createdAt - b.createdAt);
  },
  clear: () => run('queue', 'readwrite', (s) => s.clear()),
};

// ---- 縮圖快取（key＝Drive 檔案 ID）----
export const thumbDb = {
  get: (fileId) => run('thumbs', 'readonly', (s) => s.get(fileId)),
  put: (fileId, blob) => run('thumbs', 'readwrite', (s) => s.put(blob, fileId)),
  clear: () => run('thumbs', 'readwrite', (s) => s.clear()),
};

// ---- 一般鍵值（名片清單快取，讓沒網路時也看得到）----
export const kvDb = {
  get: (key) => run('kv', 'readonly', (s) => s.get(key)),
  put: (key, value) => run('kv', 'readwrite', (s) => s.put(value, key)),
  clear: () => run('kv', 'readwrite', (s) => s.clear()),
};

// 登出時清掉這台手機上的所有資料（雲端的不會動）
export async function clearAllLocal() {
  await queueDb.clear();
  await thumbDb.clear();
  await kvDb.clear();
}
