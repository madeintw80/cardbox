// App 內相機（連拍模式）：對準框框按快門，可以一直拍，拍完按「完成」一起送去辨識
// 只截取框框裡的範圍（多留一點邊），照片比較小、AI 也比較好讀

import { canvasToBlob } from './image.js';

const CARD_RATIO = 1.7;   // 名片長寬比約 9×5.4 公分 ≈ 1.67，取 1.7
const CROP_MARGIN = 0.06; // 框框外再多留 6%，避免切到字

export function cameraSupported() {
  return !!navigator.mediaDevices?.getUserMedia;
}

// 開相機；onDone(blobs) 會在按「完成」時呼叫；回傳 Promise，失敗會 reject（例如沒給相機權限）
export async function openCamera(onDone) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });

  const shots = [];
  const overlay = document.createElement('div');
  overlay.className = 'camera';
  overlay.innerHTML = `
    <video class="camera-video" autoplay playsinline muted></video>
    <div class="camera-guide"><div class="camera-frame"></div></div>
    <div class="camera-tip">把名片對準框框，可以連續拍很多張</div>
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
  const countEl = overlay.querySelector('.camera-count');
  const doneBtn = overlay.querySelector('.camera-done');
  const flash = overlay.querySelector('.camera-flash');
  video.srcObject = stream;

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
    shots.push(blob);
    countEl.textContent = String(shots.length);
    doneBtn.disabled = false;
    flash.classList.remove('on');
    void flash.offsetWidth; // 重新觸發閃光動畫
    flash.classList.add('on');
    if (navigator.vibrate) navigator.vibrate(30);
  }

  overlay.querySelector('.camera-shutter').addEventListener('click', shoot);
  overlay.querySelector('.camera-cancel').addEventListener('click', () => {
    if (shots.length && !confirm(`已經拍了 ${shots.length} 張，確定要全部丟掉嗎？`)) return;
    close();
  });
  doneBtn.addEventListener('click', () => {
    close();
    onDone(shots);
  });
}
