// App 內相機（連拍模式）：對準框框按快門，可以一直拍，拍完按「完成」一起送去辨識
// 只截取框框裡的範圍（多留一點邊），照片比較小、AI 也比較好讀

import { canvasToBlob } from './image.js';

const CARD_RATIO = 1.7;   // 名片長寬比約 9×5.4 公分 ≈ 1.67，取 1.7
const CROP_MARGIN = 0.06; // 框框外再多留 6%，避免切到字

export function cameraSupported() {
  return !!navigator.mediaDevices?.getUserMedia;
}

// 開相機；onDone(groups) 會在按「完成」時呼叫，groups＝[[正面], [正面, 背面], …]（一組＝一張名片）
// opts.sides：1＝單面（每拍一下就是一張名片）、2＝雙面（每張名片拍兩下：先正面、再背面）
// opts.onModeChange(sides)：在相機裡切換單面／雙面時通知（App 記住下次的預設）
// 回傳 Promise，失敗會 reject（例如沒給相機權限）
export async function openCamera(onDone, opts = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });

  let sides = opts.sides === 2 ? 2 : 1;
  const groups = [];
  let open = null; // 雙面模式：已經拍了正面、還在等背面的那張名片
  const overlay = document.createElement('div');
  overlay.className = 'camera';
  overlay.innerHTML = `
    <video class="camera-video" autoplay playsinline muted></video>
    <div class="camera-guide"><div class="camera-frame"></div></div>
    <div class="camera-tip"></div>
    <button type="button" class="camera-btn camera-mode"></button>
    <div class="camera-bar">
      <button type="button" class="camera-btn camera-cancel">取消</button>
      <button type="button" class="camera-shutter" aria-label="拍照"></button>
      <button type="button" class="camera-btn camera-done" disabled>完成 <span class="camera-count">0</span></button>
    </div>
    <div class="camera-flash"></div>`;
  document.body.appendChild(overlay);
  document.body.classList.add('no-scroll');

  const video = overlay.querySelector('.camera-video');
  const frame = overlay.querySelector('.camera-frame');
  const tip = overlay.querySelector('.camera-tip');
  const modeBtn = overlay.querySelector('.camera-mode');
  const countEl = overlay.querySelector('.camera-count');
  const doneBtn = overlay.querySelector('.camera-done');
  const flash = overlay.querySelector('.camera-flash');
  video.srcObject = stream;

  // 提示字、模式按鈕、張數（張數＝名片張數，不是照片張數）
  function updateUi() {
    tip.textContent = sides === 2
      ? (open ? '👉 翻面，拍「背面」' : '雙面模式：先拍「正面」')
      : '把名片對準框框，可以連續拍很多張';
    modeBtn.textContent = sides === 2 ? '🪪 雙面（點一下改單面）' : '🪪 單面（點一下改雙面）';
    const cards = groups.length + (open ? 1 : 0);
    countEl.textContent = String(cards);
    doneBtn.disabled = cards === 0;
  }
  updateUi();

  // 拍到一半換模式：已經拍的正面就當成單面名片
  function closeOpenGroup() {
    if (open) groups.push(open);
    open = null;
  }

  // 框框大小：寬度佔畫面 86%（直拿手機），比例照名片
  function layoutFrame() {
    const vw = overlay.clientWidth;
    const vh = overlay.clientHeight;
    let w = vw * 0.86;
    let h = w / CARD_RATIO;
    if (h > vh * 0.55) { h = vh * 0.55; w = h * CARD_RATIO; }
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
  }
  layoutFrame();
  window.addEventListener('resize', layoutFrame);

  function close() {
    stream.getTracks().forEach((t) => t.stop());
    window.removeEventListener('resize', layoutFrame);
    overlay.remove();
    document.body.classList.remove('no-scroll');
  }

  // 拍照：把畫面上框框的位置換算成影片的實際像素，再裁切
  async function shoot() {
    if (!video.videoWidth) return;
    const vr = video.getBoundingClientRect();
    const fr = frame.getBoundingClientRect();
    // video 是 object-fit: cover → 算出影片被放大多少、被裁掉多少
    const scale = Math.max(vr.width / video.videoWidth, vr.height / video.videoHeight);
    const offsetX = (video.videoWidth * scale - vr.width) / 2;
    const offsetY = (video.videoHeight * scale - vr.height) / 2;
    const mx = fr.width * CROP_MARGIN;
    const my = fr.height * CROP_MARGIN;
    let sx = (fr.left - vr.left - mx + offsetX) / scale;
    let sy = (fr.top - vr.top - my + offsetY) / scale;
    let sw = (fr.width + 2 * mx) / scale;
    let sh = (fr.height + 2 * my) / scale;
    sx = Math.max(0, sx); sy = Math.max(0, sy);
    sw = Math.min(video.videoWidth - sx, sw); sh = Math.min(video.videoHeight - sy, sh);

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    canvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, 0.92);
    if (sides === 2 && open) {
      open.push(blob); // 背面拍好，這張名片完成
      groups.push(open);
      open = null;
    } else if (sides === 2) {
      open = [blob];   // 正面拍好，等背面
    } else {
      groups.push([blob]);
    }
    updateUi();
    flash.classList.remove('on');
    void flash.offsetWidth; // 重新觸發閃光動畫
    flash.classList.add('on');
    if (navigator.vibrate) navigator.vibrate(30);
  }

  overlay.querySelector('.camera-shutter').addEventListener('click', shoot);
  modeBtn.addEventListener('click', () => {
    closeOpenGroup();
    sides = sides === 2 ? 1 : 2;
    opts.onModeChange?.(sides);
    updateUi();
  });
  overlay.querySelector('.camera-cancel').addEventListener('click', () => {
    const cards = groups.length + (open ? 1 : 0);
    if (cards && !confirm(`已經拍了 ${cards} 張名片，確定要全部丟掉嗎？`)) return;
    close();
  });
  doneBtn.addEventListener('click', () => {
    closeOpenGroup();
    close();
    onDone(groups);
  });
}
