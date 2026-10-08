# 名片盒 CardBox — 規格與進度

## 一句話

給朋友自用的「拍名片 → AI 自動整理成聯絡人」手機網頁 App（PWA）。她用自己的 Google 帳號登入，照片和資料存在她自己的 Google 雲端硬碟；名片由 Boss 電腦上的 Claude（Boss 的訂閱）來讀。

## 決策紀錄

| # | 題目 | 拍板 |
|---|------|------|
| 1 | 入口 | 手機網頁 App（PWA），App 內連拍＋相簿批次上傳；不用 Telegram |
| 2 | 使用者 | 給朋友自己用，用她自己的 Gmail 登入，資料在她自己的雲端 |
| 3 | 資料存放 | Google Sheet（一張名片一列）＋照片存 Drive 私人資料夾 |
| 4 | 查詢 | App 內搜尋 |
| 5 | 辨識 | Boss 電腦上的 Claude（訂閱額度，`claude -p`，Opus 5.5），經 Cloudflare 收件櫃中繼；Boss 接受名片會經過他的電腦、電腦要開著 |
| 6 | Google 專案 | 沿用 BroTrip 的 OAuth Client（授權畫面會顯示「BroTrip」） |

替 Boss 決定的小事：App 名稱「名片盒」、單一 public repo（程式碼不含任何個資）、正反面自動合併（30 分鐘內手機或 Email 相同）、中文優先、重新辨識先看差異再套用、刪除時照片進雲端垃圾桶（不永久刪除）、每帳號每日 200 張上限、拿件小程式同時讀 2 張。

## 架構

```
她的手機（PWA，GitHub Pages）
  ├─ Google 登入（GIS token client，scope＝drive.file＋email）
  ├─ 照片 → 她的 Drive「名片盒 CardBox」資料夾
  ├─ 名片 → 她的 Sheet「名片盒資料」分頁 Cards
  └─ 照片 → 收件櫃 POST /jobs，每 2.5 秒 GET /jobs/:id 問結果
                 │
        Cloudflare Worker cardbox-ocr（收件櫃）
          ├─ App 端：tokeninfo 驗 aud＝Client ID、email 在 ALLOWED_EMAILS、KV 每日上限
          ├─ D1 cardbox-jobs：jobs（pending→working→done/error）＋meta（runner_seen）
          └─ 電腦端：RUNNER_SECRET；claim 用單一 UPDATE…RETURNING 原子領件，5 分鐘租約
                 ▲
        Boss 電腦 runner/cardbox_runner.py（resident 服務 CardBox）
          ├─ 每 3 秒往外問一次（不開任何對外的門）
          └─ claude -p：圖片放 stream-json 輸入、--tools ""（Claude 沒有任何工具）、--json-schema
```

- **為什麼是收件櫃**：Claude 訂閱只能在 Boss 電腦上用，電腦不對外開門、只主動拿件，比開 tunnel 安全
- **drive.file 權限**：App 只看得到自己建立的檔案，看不到她雲端裡其他東西；不需要 Google 審核
- **找檔案**靠 Drive `appProperties`（cardbox=root／data／photo），使用者改名也找得到
- **App 佇列存 IndexedDB**：一次上傳 50 張中途關 App，下次打開接著做；件號（jobId）記在佇列裡，重試時接著等同一件
- **電腦離線**：App 等 30 秒寬限後顯示「辨識主機離線，照片已排隊」，件留在櫃子裡（最多 24 小時）
- **收件櫃保存期限**：讀完立刻清掉照片（只留文字結果 1 小時給 App 拿），任何件最多放 24 小時
- **Sheet 寫入前重查列號**（避免兩台手機同時操作改錯列）

## Sheet 欄位（只能往後加）

`id, created_at, updated_at, name, name_alt, company, department, title, mobile, phone, fax, email, website, address, social, note, tags, photos(JSON), status, raw_text`

## 檔案地圖

| 檔案 | 用途 |
|------|------|
| `index.html`／`css/app.css`／`manifest.webmanifest`／`sw.js` | 外框、樣式、PWA、離線快取（network-first） |
| `js/config.js` | 版本、Client ID、收件櫃網址 |
| `js/app.js` | 畫面與事件（清單／詳細／編輯／設定） |
| `js/auth.js` | Google 登入（沿用 BroTrip 驗證過的寫法） |
| `js/google.js` | Drive／Sheets 存取 |
| `js/queue.js` | 上傳＋辨識佇列 |
| `js/cards.js` | 純邏輯：欄位、搜尋、正反面合併、vCard（有單元測試） |
| `js/ocr.js` | 放件＋輪詢收件櫃 |
| `js/camera.js` | App 內連拍相機 |
| `js/demo.js` | 試玩模式（`?demo=1`，不連 Google、假 AI） |
| `worker/src/index.js`／`worker/schema.sql` | 收件櫃 Worker＋D1 表結構（借 Guandan5 的 wrangler，無 npm 套件） |
| `runner/cardbox_runner.py`／`runner/cardbox_runner_launcher.bat` | 拿件小程式＋常駐啟動器 |
| `tools/setup_runner_secret.py` | 產生 RUNNER_SECRET（存 `~/.claude/secrets/cardbox_runner.env`＋設定到 Cloudflare） |
| `tools/write_bats.py` | 產生 CRLF＋ASCII 的 bat |
| `tests/cards.test.mjs` | 單元測試 |
| `worker/smoke_test.py` | 收件櫃安全檢查（不花額度） |
| `worker/e2e_local.py` | 本機端到端（真的用一次 Claude） |

## 常駐服務（resident `CardBox`）

- 管理器：`scripts/resident_services_hidden.ps1 -Service CardBox`（catalog／visible_host 同步登記）；port 47960 單例鎖＋accept-drain；`replace_stale` 600 秒
- 心跳：`runner/logs/heartbeat.txt`（主迴圈每 5 秒，兩個工作執行緒 400 秒內都有跑完一輪才寫）；`_common/heartbeat.py` 門檻 2h
- 監看排程：`Batnini CardBox Watch` 每 30 分（:11／:41，隱藏）
- 改程式：存檔 10 秒後自動重載（batnini_reload，沒有正在讀的名片時才換版），不用重啟
- log：`runner/logs/runner.log`（輪替 1MB×3）、`runner/logs/launch.log`

## 驗證狀態（2026-10-08）

- ✅ 單元測試 12/12（`node --test tests/cards.test.mjs`）
- ✅ 試玩模式端到端：批次 → 排隊辨識 → 正反面自動合併 → 編輯 → 搜尋 → 刪除 → 設定頁
- ✅ 本機收件櫃：安全檢查 8/8、端到端 6/6（真的用 Claude 讀測試名片，10 秒）
- ✅ App 真正的 `ocr.js` 對接本機收件櫃：等待辨識 → 辨識中 → 拿到結果（12.9 秒）；電腦離線時 83 秒後顯示離線提示
- ✅ 線上收件櫃安全檢查 10/10；拿件小程式以常駐服務上線、線上 D1 顯示 0.8 秒前報到
- ⏳ 未驗證：真 Google 登入／Drive／Sheets、手機實機相機（要 Boss 用手機測；先設好白名單）

## 線上狀態

- App：`https://madeintw80.github.io/cardbox/`（repo `madeintw80/cardbox` public，Pages＝main／root），v0.2.0
- 收件櫃：`https://cardbox-ocr.madeintw80.workers.dev`（D1 `cardbox-jobs`、KV `USAGE`）
- 機密：`RUNNER_SECRET`（已設）、`ALLOWED_EMAILS`（**待 Boss 雙擊 `worker/set_allowed_emails.bat`**；沒設之前所有人 403）
- ⚠️ 線上冒煙要帶瀏覽器 User-Agent（Cloudflare 會擋 Python 預設 UA，回 error code 1010）；拿件小程式用自訂 UA
- ⚠️ 部署後 10～40 秒內新舊版會交替（舊版路徑回 404），測試要等一下

## 部署（對外動作，每次先問 Boss）

- 收件櫃：`node <Guandan5>/node_modules/wrangler/bin/wrangler.js deploy --config worker/wrangler.jsonc`；改表結構先 `d1 execute cardbox-jobs --remote --file worker/schema.sql`
- App：升版三處同步（`js/config.js` VERSION ＋ `sw.js` CACHE ＋ `index.html`／`sw.js` 的 `?v=`）→ push → 實讀線上 `js/config.js` 版本

## 待辦／之後可以加

- 手動合併兩張名片、標籤篩選、「待補」名片篩選
