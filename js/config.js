// 名片盒 CardBox — 全域設定
// 升版時要同步三個地方：這裡的 VERSION、sw.js 的 CACHE、index.html 與 sw.js 裡所有 ?v=

export const VERSION = '0.1.0';

// Google OAuth Client ID（公開值，不是機密）：沿用 BroTrip 的 Google 專案（2026-10-08 Boss 拍板）
// 已授權網址＝https://madeintw80.github.io（同一個網域下的 /cardbox/ 直接能用）
// 副作用：她第一次登入時，Google 授權畫面上的 App 名稱會顯示「BroTrip」
export const GOOGLE_CLIENT_ID = '38081255296-ojiesn8jsdlkrsa5snlue0s3tprro3rq.apps.googleusercontent.com';

// 辨識中繼站（Cloudflare Worker）網址；部署後填入，例：https://cardbox-ocr.xxx.workers.dev
export const OCR_ENDPOINT = '';

// 只要「自己的 App 建立的檔案」權限（drive.file）＋取得 Email 讓中繼站確認是誰
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

// 雲端硬碟裡的資料夾／試算表名稱（找檔案靠 appProperties 標記，不靠名稱）
export const ROOT_FOLDER_NAME = '名片盒 CardBox';
export const SHEET_NAME = '名片盒資料';
export const SHEET_TAB = 'Cards';

// 照片壓縮：長邊最多 1600px（Claude 讀圖建議上限附近，字夠清楚又不浪費）
export const IMAGE_MAX_SIDE = 1600;
export const IMAGE_QUALITY = 0.85;
export const THUMB_MAX_SIDE = 240;

// 同時處理幾張（上傳＋辨識）；太多會撞中繼站的每分鐘上限
export const QUEUE_CONCURRENCY = 2;

// 試玩模式：網址帶 ?demo=1 → 不連 Google、不呼叫 AI，用假資料跑完整流程
export const DEMO_MODE = new URLSearchParams(location.search).has('demo');
