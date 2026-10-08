// 上傳＋辨識排隊：拍照／選相簿的照片先放進手機本機佇列，再一張張「上傳 Drive → AI 辨識 → 寫進 Sheet」
// 為什麼要排隊：一次選 50 張不能同時丟，會撞中繼站上限；而且中途關 App，下次打開會接著做

import { QUEUE_CONCURRENCY } from './config.js';
import { queueDb, thumbDb } from './localdb.js';
import { resizeImage, makeThumb } from './image.js';
import { recognizeCard } from './ocr.js';
import { Store, backend } from './store.js';
import { makeCardFromOcr, mergeBackSide, isSamePerson } from './cards.js';

const MAX_AUTO_RETRY = 3;
const MERGE_WINDOW_MS = 30 * 60 * 1000; // 30 分鐘內拍的同一人（手機或 Email 相同）→ 當成正反面合併

const listeners = new Set();
let saveChain = Promise.resolve(); // 寫進 Sheet 要「一張一張來」，正反面才不會同時各建一張

export const Queue = {
  items: [],   // { qid, blob, thumb, createdAt, state: queued|working|error, step, error, retryable, tries, photoId }
  running: 0,
  paused: false, // 登入過期時暫停，重新登入後繼續

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emit() {
    for (const fn of listeners) fn();
  },

  // App 打開時：把上次沒做完的撿回來繼續
  async init() {
    this.items = await queueDb.all();
    for (const item of this.items) {
      if (item.state === 'working') item.state = 'queued'; // 上次做到一半被關掉
    }
    this.emit();
    this.pump();
  },

  // 加入照片（相機拍的或相簿選的都走這裡）
  async addFiles(files) {
    let added = 0;
    const base = Date.now();
    for (const [i, file] of [...files].entries()) {
      try {
        const blob = await resizeImage(file);
        const thumb = await makeThumb(blob);
        const item = {
          qid: `q_${base.toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`,
          blob, thumb,
          createdAt: base + i,
          state: 'queued', step: '', error: '', retryable: true, tries: 0, photoId: '',
        };
        await queueDb.put(item);
        this.items.push(item);
        added += 1;
        this.emit();
      } catch (err) {
        console.warn('add file failed', err);
      }
    }
    this.pump();
    return added;
  },

  pump() {
    if (this.paused) return;
    while (this.running < QUEUE_CONCURRENCY) {
      const next = this.items.find((it) => it.state === 'queued');
      if (!next) break;
      this._run(next);
    }
  },

  async _run(item) {
    this.running += 1;
    item.state = 'working';
    item.error = '';
    this.emit();
    try {
      // 1) 照片先上傳到她的 Drive（上傳過就不重傳）
      if (!item.photoId) {
        item.step = '上傳中';
        this.emit();
        item.photoId = await backend.uploadPhoto(item.blob, photoFileName(item.createdAt));
        await queueDb.put(item);
      }
      // 2) 請 AI 讀名片
      item.step = '辨識中';
      this.emit();
      const ocr = await recognizeCard(item.blob);
      if (!ocr.is_business_card) {
        const err = new Error('這張看起來不是名片');
        err.retryable = false;
        err.notCard = true;
        throw err;
      }
      // 3) 寫進 Sheet（排隊一張一張寫）
      item.step = '儲存中';
      this.emit();
      await this._serialSave(() => saveOcrResult(item, ocr));
      await thumbDb.put(item.photoId, item.thumb).catch(() => {});
      await this._drop(item);
    } catch (err) {
      item.state = 'error';
      item.step = '';
      item.error = err.message || String(err);
      item.retryable = err.retryable !== false;
      item.notCard = !!err.notCard;
      item.tries += 1;
      await queueDb.put(item).catch(() => {});
      if (/登入|token|續登|401/i.test(item.error)) {
        this.paused = true; // 登入過期：先停，等重新登入
      } else if (item.retryable && item.tries < MAX_AUTO_RETRY) {
        setTimeout(() => this.retry(item.qid), 4000 * item.tries); // 4 秒、8 秒後自動重試
      }
    } finally {
      this.running -= 1;
      this.emit();
      this.pump();
    }
  },

  _serialSave(fn) {
    const p = saveChain.then(fn);
    saveChain = p.catch(() => {});
    return p;
  },

  async _drop(item) {
    await queueDb.remove(item.qid);
    this.items = this.items.filter((it) => it.qid !== item.qid);
  },

  retry(qid) {
    const item = this.items.find((it) => it.qid === qid);
    if (!item || item.state === 'working') return;
    item.state = 'queued';
    item.error = '';
    this.emit();
    this.pump();
  },

  retryAll() {
    this.paused = false;
    for (const it of this.items) {
      if (it.state === 'error') { it.state = 'queued'; it.error = ''; it.tries = 0; }
    }
    this.emit();
    this.pump();
  },

  resume() {
    this.paused = false;
    this.pump();
  },

  // 不辨識了，直接存成空白名片讓她自己打字
  async saveAsBlank(qid) {
    const item = this.items.find((it) => it.qid === qid);
    if (!item || item.state === 'working') return null;
    item.state = 'working';
    item.step = '儲存中';
    this.emit();
    try {
      if (!item.photoId) item.photoId = await backend.uploadPhoto(item.blob, photoFileName(item.createdAt));
      const card = makeCardFromOcr({}, item.photoId);
      await this._serialSave(() => Store.add(card));
      await thumbDb.put(item.photoId, item.thumb).catch(() => {});
      await this._drop(item);
      return card;
    } catch (err) {
      item.state = 'error';
      item.error = err.message;
      return null;
    } finally {
      this.emit();
    }
  },

  // 從佇列移除（照片如果已上傳，會留在她的 Drive 資料夾裡，不會亂刪）
  async discard(qid) {
    const item = this.items.find((it) => it.qid === qid);
    if (!item || item.state === 'working') return;
    await this._drop(item);
    this.emit();
  },

  get pendingCount() {
    return this.items.length;
  },
};

// 照片檔名：card_20261008_141230_123.jpg（看 Drive 資料夾時一眼知道哪天拍的）
function photoFileName(ts) {
  const d = new Date(ts);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `card_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_`
    + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}.jpg`;
}

// 辨識完：30 分鐘內有同一人（手機或 Email 一樣）→ 合併成正反面；否則新增一張
async function saveOcrResult(item, ocr) {
  const now = Date.now();
  const twin = Store.cards.find((c) =>
    now - new Date(c.created_at).getTime() < MERGE_WINDOW_MS && isSamePerson(c, ocr));
  if (twin) {
    await Store.update(mergeBackSide(twin, ocr, item.photoId));
  } else {
    await Store.add(makeCardFromOcr(ocr, item.photoId));
  }
}
