// 共用小元件：跳脫文字（防 XSS）、提示訊息、確認視窗、選單、橫幅

// 所有「名片上讀到的文字」放進畫面前都要跳脫，否則名片上寫 <script> 就會被執行
export function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer = null;
export function toast(message, ms = 2400) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// 確認視窗：回傳 Promise<boolean>
export function confirmDialog({ title, message = '', okText = '確定', cancelText = '取消', danger = false, html = '' }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3 class="modal-title">${esc(title)}</h3>
        ${message ? `<p class="modal-msg">${esc(message)}</p>` : ''}
        ${html}
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-r="0">${esc(cancelText)}</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-r="1">${esc(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const done = (v) => { wrap.remove(); resolve(v); };
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-r]');
      if (btn) done(btn.dataset.r === '1');
      else if (e.target === wrap) done(false);
    });
  });
}

// 底部選單：actions = [{ label, value, danger }]；回傳選到的 value（取消＝null）
export function actionSheet(title, actions) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop sheet-backdrop';
    wrap.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true">
        ${title ? `<div class="sheet-title">${esc(title)}</div>` : ''}
        ${actions.map((a, i) => `<button type="button" class="sheet-btn ${a.danger ? 'danger' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}
        <button type="button" class="sheet-btn sheet-cancel" data-i="-1">取消</button>
      </div>`;
    document.body.appendChild(wrap);
    const done = (v) => { wrap.remove(); resolve(v); };
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-i]');
      if (btn) {
        const i = Number(btn.dataset.i);
        done(i >= 0 ? actions[i].value : null);
      } else if (e.target === wrap) done(null);
    });
  });
}

// 頁面最上方的橫幅（登入過期、有新版本）；onClick 為 null 時只顯示文字
export function showBanner(id, text, buttonText, onClick) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.className = 'banner';
    document.body.appendChild(el);
  }
  el.innerHTML = `<span>${esc(text)}</span>${buttonText ? `<button type="button" class="btn btn-small">${esc(buttonText)}</button>` : ''}`;
  const btn = el.querySelector('button');
  if (btn && onClick) btn.addEventListener('click', onClick);
}

export function hideBanner(id) {
  document.getElementById(id)?.remove();
}

// 分享或下載檔案（加入通訊錄用）：手機上會跳出分享選單，選「通訊錄」就能存
export async function shareOrDownload(text, fileName, mime) {
  const file = new File([text], fileName, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'downloaded';
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// 偵測 LINE／FB／IG 內建瀏覽器（Google 會擋這些瀏覽器登入）
export function detectInAppBrowser() {
  const ua = navigator.userAgent || '';
  if (/Line\//i.test(ua)) return 'LINE';
  if (/FBAN|FBAV|FB_IAB|FB4A/.test(ua)) return 'Facebook';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/MessengerForiOS|Messenger/i.test(ua)) return 'Messenger';
  if (/MicroMessenger/i.test(ua)) return 'WeChat';
  if (/iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)) return 'App 內建瀏覽器';
  if (/Android/.test(ua) && /; wv\)/.test(ua)) return 'App 內建瀏覽器';
  return null;
}

export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

export function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
