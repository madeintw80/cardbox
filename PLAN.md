# 名片盒 CardBox — 規格與進度

## 一句話

給朋友自用的「拍名片 → AI 自動整理成聯絡人」手機網頁 App（PWA）。她用自己的 Google 帳號登入，照片和資料存在她自己的 Google 雲端硬碟；AI 辨識費用由 Boss 的 Claude API 帳號支付。

## 決策紀錄（2026-10-08 kickoff）

| # | 題目 | 拍板 |
|---|------|------|
| 1 | 入口 | 手機網頁 App（PWA），App 內拍照＋相簿批次上傳；**不用 Telegram** |
| 2 | 使用者 | 給朋友自己用，用**她自己的 Gmail** 登入，資料在她自己的雲端 |
| 3 | 資料存放 | Google Sheet（一張名片一列）＋照片存 Drive 私人資料夾 |
| 4 | 查詢 | App 內搜尋 |
| 5 | 辨識 | Claude **Opus 5.5**，經 Cloudflare Worker 中繼，費用 Boss 出（每張約 NT$0.7） |
| 6 | Google 專案 | **沿用 BroTrip 的 OAuth Client**（不開新專案；授權畫面會顯示「BroTrip」） |

替 Boss 決定的小事：App 名稱「名片盒」、單一 public repo（程式碼不含任何個資）、正反面自動合併（30 分鐘內手機或 Email 相同）、中文優先、重新辨識先看差異再套用、刪除時照片進雲端垃圾桶（不永久刪除）、每帳號每日 200 張上限。

## 架構

```
手機（PWA，GitHub Pages）
  ├─ Google 登入（GIS token client，scope＝drive.file＋email）
  ├─ 照片 → 她的 Drive「名片盒 CardBox」資料夾
  ├─ 名片 → 她的 Sheet「名片盒資料」分頁 Cards
  └─ 照片 base64 ＋ Google token → 中繼站
                                   ├─ tokeninfo 驗 aud＝Client ID、email 在 ALLOWED_EMAILS
                                   ├─ KV 每日用量上限
                                   └─ Claude Opus 5.5（structured outputs JSON）→ 回傳欄位（不留存）
```

- **drive.file 權限**：App 只看得到自己建立的檔案，看不到她雲端裡其他東西；不需要 Google 審核
- **找檔案**靠 Drive `appProperties`（cardbox=root／data／photo），使用者改名也找得到
- **佇列存 IndexedDB**：一次上傳 50 張中途關 App，下次打開接著做；同時處理 2 張；可重試／存空白自己填／丟掉
- **Sheet 寫入前重查列號**（避免兩台手機同時操作改錯列）

## Sheet 欄位（只能往後加）

`id, created_at, updated_at, name, name_alt, company, department, title, mobile, phone, fax, email, website, address, social, note, tags, photos(JSON), status, raw_text`

## 檔案地圖

| 檔案 | 用途 |
|------|------|
| `index.html`／`css/app.css`／`manifest.webmanifest`／`sw.js` | 外框、樣式、PWA、離線快取（network-first） |
| `js/config.js` | 版本、Client ID、中繼站網址 |
| `js/app.js` | 畫面與事件（清單／詳細／編輯／設定） |
| `js/auth.js` | Google 登入（沿用 BroTrip 驗證過的寫法） |
| `js/google.js` | Drive／Sheets 存取 |
| `js/queue.js` | 上傳＋辨識佇列 |
| `js/cards.js` | 純邏輯：欄位、搜尋、正反面合併、vCard（有單元測試） |
| `js/ocr.js` | 呼叫中繼站 |
| `js/camera.js` | App 內連拍相機 |
| `js/demo.js` | 試玩模式（`?demo=1`，不連 Google、假 AI） |
| `worker/` | Cloudflare Worker 中繼站（`@anthropic-ai/sdk`，借 Guandan5 的 wrangler） |
| `tests/cards.test.mjs` | 單元測試 |
| `worker/smoke_test.py` | 中繼站安全檢查（不花錢） |

## 驗證狀態（2026-10-08）

- ✅ 單元測試 12/12（`node --test tests/cards.test.mjs`）
- ✅ 中繼站本機安全檢查 7/7（陌生網站 403、沒登入／假憑證 401、CORS 正確）
- ✅ 中繼站打包 674KB（dry-run）
- ✅ 試玩模式端到端：4 張批次 → 排隊辨識 → 正反面自動合併 → 編輯儲存 → 搜尋（標籤／電話）→ 刪除 → 設定頁
- ⏳ 未驗證：真 Google 登入／Drive／Sheets、真 Claude 辨識（等 Boss 設 API 金鑰＋白名單）、iPhone／Android 實機相機

## 線上狀態（2026-10-08 部署）

- App：`https://madeintw80.github.io/cardbox/`（repo `madeintw80/cardbox` public，Pages＝main／root），線上 v0.1.1
- 中繼站：`https://cardbox-ocr.madeintw80.workers.dev`（KV `USAGE` id `25db6611…`），線上安全冒煙 7/7
- ⚠️ 線上冒煙要帶瀏覽器 User-Agent（Cloudflare 會擋 Python 預設 UA，回 error code 1010），`smoke_test.py` 已內建
- 待 Boss：`worker/set_api_key.bat`（Claude API 金鑰）＋ `worker/set_allowed_emails.bat`（白名單）。沒設之前：白名單空＝所有人 403、沒金鑰＝辨識回「AI 服務設定有問題」

## 部署步驟（對外動作，每次先問 Boss）

1. 中繼站：`wrangler kv namespace create USAGE` → id 填進 `worker/wrangler.jsonc` → `wrangler deploy`
2. Boss 雙擊 `worker/set_api_key.bat`（貼 Claude API 金鑰）＋ `worker/set_allowed_emails.bat`（填可用 Gmail）
3. 中繼站網址填進 `js/config.js` 的 `OCR_ENDPOINT`
4. GitHub `madeintw80/cardbox`（public）push → Pages（main／root）→ `https://madeintw80.github.io/cardbox/`
5. 實機驗收：登入 → 拍一張 → 看 Sheet 有沒有出現

升版：`js/config.js` VERSION ＋ `sw.js` CACHE ＋ `index.html`／`sw.js` 的 `?v=` 一起改。

## 待辦／之後可以加

- 手動合併兩張名片、標籤篩選
- 列表顯示「待補」（status=error）的篩選
- 中繼站每月用量報表（目前看 Anthropic Console）
