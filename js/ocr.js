// 名片辨識：把照片送到辨識中繼站（Cloudflare Worker），中繼站再請 Claude 讀
// App 這邊不放任何 AI 金鑰；中繼站會用她的 Google 登入確認是名單上的人才幫忙讀

import { Auth } from './auth.js';
import { OCR_ENDPOINT, DEMO_MODE } from './config.js';
import { blobToBase64 } from './image.js';
import { cleanOcrResult } from './cards.js';
import { demoRecognize } from './demo.js';

export class OcrError extends Error {
  constructor(message, { status = 0, code = '', retryable = true } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable; // false＝重試也沒用（例如沒有使用權限）
  }
}

// 中繼站錯誤代碼 → 給使用者看的話
const MESSAGES = {
  not_allowed: '這個 Google 帳號沒有辨識權限，請找管理員把你加進名單',
  bad_token: '登入狀態失效，請重新登入',
  daily_limit: '今天的辨識額度用完了，明天會自動恢復',
  rate_limit: '辨識太頻繁，稍等一下會自動重試',
  too_large: '照片太大，請重拍',
  refused: 'AI 拒絕讀這張圖（可能不是名片）',
  ai_error: 'AI 暫時沒回應，稍後會自動重試',
};

export async function recognizeCard(blob) {
  if (DEMO_MODE) return cleanOcrResult(await demoRecognize());
  if (!OCR_ENDPOINT) throw new OcrError('辨識中繼站還沒設定', { retryable: false });

  const token = await Auth.ensureToken();
  const image = await blobToBase64(blob);
  let resp;
  try {
    resp = await fetch(`${OCR_ENDPOINT}/ocr`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, media_type: blob.type || 'image/jpeg' }),
    });
  } catch {
    throw new OcrError('網路連不上辨識中繼站，稍後會自動重試');
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const code = data.code || '';
    const retryable = !['not_allowed', 'too_large', 'refused', 'bad_request'].includes(code);
    throw new OcrError(MESSAGES[code] || data.error || `辨識失敗（${resp.status}）`, {
      status: resp.status, code, retryable,
    });
  }
  return cleanOcrResult(data.card);
}
