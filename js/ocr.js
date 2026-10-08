// 名片辨識：照片放進「收件櫃」（Cloudflare Worker），Boss 電腦上的 Claude 會來拿去讀，
// App 每 2.5 秒問一次讀好了沒。App 端不放任何 AI 金鑰；收件櫃會用她的 Google 登入確認是名單上的人。
//
// 流程：POST /jobs（放照片，拿到件號）→ GET /jobs/<件號>（輪詢）→ done 就拿到欄位

import { Auth } from './auth.js';
import { OCR_ENDPOINT, DEMO_MODE } from './config.js';
import { blobToBase64 } from './image.js';
import { cleanOcrResult } from './cards.js';
import { demoRecognize } from './demo.js';

const POLL_MS = 2500;
const GIVE_UP_MS = 6 * 60 * 1000;      // 等超過 6 分鐘就先放棄（件還在櫃子裡，重試會接著等同一件）
const OFFLINE_GRACE_MS = 30 * 1000;    // 電腦離線超過 30 秒才告訴使用者

export class OcrError extends Error {
  constructor(message, { status = 0, code = '', retryable = true } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable; // false＝重試也沒用（例如沒有使用權限）
  }
}

// 收件櫃錯誤代碼 → 給使用者看的話
const MESSAGES = {
  not_allowed: '這個 Google 帳號沒有辨識權限，請找管理員把你加進名單',
  bad_token: '登入狀態失效，請重新登入',
  daily_limit: '今天的辨識額度用完了，明天會自動恢復',
  too_large: '照片太大，請重拍',
  runner_offline: '辨識主機（管理員的電腦）目前離線，照片已排隊，稍後按「重試」會接著辨識',
  timeout: '辨識等太久了，稍後按「重試」會接著等',
};

async function request(method, path, body) {
  const token = await Auth.ensureToken();
  let resp;
  try {
    resp = await fetch(`${OCR_ENDPOINT}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new OcrError('網路連不上辨識中繼站，稍後會自動重試');
  }
  const data = await resp.json().catch(() => ({}));
  return { resp, data };
}

function errorFrom(resp, data) {
  const code = data.code || '';
  const retryable = !['not_allowed', 'too_large', 'bad_request'].includes(code);
  return new OcrError(MESSAGES[code] || data.error || `辨識失敗（${resp.status}）`, {
    status: resp.status, code, retryable,
  });
}

// 讀一張名片
//   opts.jobId     上次已經放進櫃子的件號（重試時接著等，不重新上傳）
//   opts.onJob     拿到件號時呼叫（佇列會記下來）
//   opts.onStatus  狀態變化時呼叫：'waiting'（排隊等電腦）｜'reading'（電腦讀取中）
export async function recognizeCard(blob, opts = {}) {
  if (DEMO_MODE) return cleanOcrResult(await demoRecognize());
  if (!OCR_ENDPOINT) throw new OcrError('辨識中繼站還沒設定', { retryable: false });

  let jobId = opts.jobId || '';
  // 1) 放進櫃子（沒有舊件號才放）
  if (!jobId) {
    const image = await blobToBase64(blob);
    const { resp, data } = await request('POST', '/jobs', { image, media_type: blob.type || 'image/jpeg' });
    if (!resp.ok) throw errorFrom(resp, data);
    jobId = data.id;
    opts.onJob?.(jobId);
  }

  // 2) 每 2.5 秒問一次
  const started = Date.now();
  let offlineSince = 0;
  while (Date.now() - started < GIVE_UP_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const { resp, data } = await request('GET', `/jobs/${jobId}`);
    if (resp.status === 404) {
      // 件已經過期被清掉（例如隔天才重試）→ 重新放一次
      opts.onJob?.('');
      return recognizeCard(blob, { ...opts, jobId: '' });
    }
    if (!resp.ok) throw errorFrom(resp, data);

    if (data.status === 'done') return cleanOcrResult(data.card);
    if (data.status === 'error') {
      opts.onJob?.(''); // 失敗的件不要再接著等，重試時重新放
      throw new OcrError(data.error || '辨識失敗', { code: 'ocr_failed' });
    }
    opts.onStatus?.(data.status === 'working' ? 'reading' : 'waiting');

    // 電腦離線：等一下下（可能剛好在重開），太久就先告訴使用者
    if (data.status === 'pending' && !data.runner_online) {
      offlineSince = offlineSince || Date.now();
      if (Date.now() - offlineSince > OFFLINE_GRACE_MS) {
        throw new OcrError(MESSAGES.runner_offline, { code: 'runner_offline' });
      }
    } else {
      offlineSince = 0;
    }
  }
  throw new OcrError(MESSAGES.timeout, { code: 'timeout' });
}
