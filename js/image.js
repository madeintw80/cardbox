// 照片處理：壓縮、轉正、縮圖、轉 base64
// 為什麼要壓縮：手機原圖 3～8MB，上傳慢又佔空間；長邊 1600px 的 JPEG 約 200～400KB，字還是很清楚

import { IMAGE_MAX_SIDE, IMAGE_QUALITY, THUMB_MAX_SIDE } from './config.js';

// 讀進圖片（createImageBitmap 會自動照 EXIF 方向轉正，直拍的照片不會躺著）
async function loadBitmap(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // 少數舊瀏覽器不支援參數 → 退回 <img> 讀法
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// 把圖片縮到長邊 maxSide 以內，輸出 JPEG Blob
export async function resizeImage(blob, maxSide = IMAGE_MAX_SIDE, quality = IMAGE_QUALITY) {
  const bmp = await loadBitmap(blob);
  const w = bmp.width;
  const h = bmp.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // 透明 PNG 轉 JPEG 時背景變白，不會變黑
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if (bmp.close) bmp.close();
  return canvasToBlob(canvas, quality);
}

export function canvasToBlob(canvas, quality = IMAGE_QUALITY) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('圖片轉檔失敗'))), 'image/jpeg', quality);
  });
}

// 列表用的小縮圖
export function makeThumb(blob) {
  return resizeImage(blob, THUMB_MAX_SIDE, 0.7);
}

// Blob → base64 字串（不含 data:image/jpeg;base64, 前綴），送給辨識中繼站用
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
