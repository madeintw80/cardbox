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
| 7 | 公司全名（v0.3.0） | 名片常只印簡寫：辨識主機用 email 網域／名片網址看官網，再請 Claude 對照名片地址判斷全名；有候選但對不上時加「（待確認）」，沒把握就留空 |
| 8 | 公司檔案（v0.3.0） | 公司層級的資料存一份「公司檔案」，同公司的名片共用；名片自動歸屬（先比公司信箱網域、再比公司名），可在名片編輯頁手動改；全名放公司檔案、名片上的「公司」欄照名片印的 |
| 9 | AI 簡介（v0.3.0） | 查全名時順便寫一句白話「在做什麼」＋產業類別＋地區，標「自動產生」、她改過就不再標；同一家公司只查一次（辨識主機本機快取） |
| 10 | 公司欄位（v0.3.0） | 關係（預設貿易商／直接用戶）、產業類別、地區、內外銷、材料來源都是下拉選單，可「＋ 新增選項」，填過的值自動變成選項；需求產品一列一個產品＋月用量（噸/月） |
| 11 | 排序（v0.3.0） | 加「📅 日曆」看哪天加入的名片；排序列的「＋」可以自己新增依某欄位分組的排序 |
| 12 | 國籍（v0.3.1） | 每張名片（個人）一個「國籍」下拉選單＋新增選項，由使用者自己選，AI 不猜（名片只看得出公司在哪，看不出人是哪國人，靠名字猜容易錯又變刻板印象）；飲食禁忌、宗教習慣等特殊需求寫在備註 |
| 13 | 補查公司檔案（v0.3.1） | 設定頁按鈕：v0.3.0 以前拍的名片（或公司全名、簡介都空著的）把照片重新交給辨識主機，只拿公司檔案草稿、名片欄位不動；同公司已經查好的直接歸過去不重讀；資料在各自的雲端，誰的帳號按就補誰的 |

替 Boss 決定的小事：App 名稱「名片盒」、單一 public repo（程式碼不含任何個資）、正反面自動合併（30 分鐘內手機或 Email 相同）、中文優先、重新辨識先看差異再套用、刪除時照片進雲端垃圾桶（不永久刪除）、每帳號每日 200 張上限、拿件小程式同時讀 2 張。v0.3.0 起：材料來源和內外銷是公司層級（不是每個產品各一個）；匯出通訊錄的「公司」照名片印的、公司全名寫進備註；刪公司檔案不刪名片；自訂排序存在手機本機（不同步到別台）；選單整理在「設定 → 整理下拉選單」，改名會先列出影響哪些公司再確認。

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
          ├─ claude -p：圖片放 stream-json 輸入、--tools ""（Claude 沒有任何工具）、--json-schema
          └─ runner/company_profile.py：讀完名片再查公司檔案草稿（全名／在做什麼／產業／地區）
               ├─ Python 自己看官網首頁（標題、簡介、版權行、頁尾），只連公開網站（內網、本機、Tailscale 位址一律擋，轉址也檢查）
               ├─ 官網線索＋名片文字交給 claude -p（一樣沒有工具）判斷
               └─ 本機快取 runner/cache/company_profiles.json（同網域或同公司名 90 天內不重查；不進 git）
```

- **公司檔案流程**：辨識結果多帶 `company_full／company_about／company_industry／company_region` 四欄 → App 存名片前先找公司檔案（`Store.linkCompany`：先比公司信箱網域、再比公司名骨幹）→ 找到就只補公司還空著的欄位，找不到就建一個新的；這段在存檔排隊裡一張一張跑，同公司兩張同時辨識完也不會建出兩個檔案
- **舊版相容**：舊 App（v0.2.0）會忽略多出來的四欄；舊試算表第一次被新版打開時自動補 `Companies` 分頁和新欄位標題，舊資料不動；v0.3.0 以前拍的名片按「重新辨識」就會補建公司檔案

- **為什麼是收件櫃**：Claude 訂閱只能在 Boss 電腦上用，電腦不對外開門、只主動拿件，比開 tunnel 安全
- **drive.file 權限**：App 只看得到自己建立的檔案，看不到她雲端裡其他東西；不需要 Google 審核
- **找檔案**靠 Drive `appProperties`（cardbox=root／data／photo），使用者改名也找得到
- **App 佇列存 IndexedDB**：一次上傳 50 張中途關 App，下次打開接著做；件號（jobId）記在佇列裡，重試時接著等同一件
- **電腦離線**：App 等 30 秒寬限後顯示「辨識主機離線，照片已排隊」，件留在櫃子裡（最多 24 小時）
- **收件櫃保存期限**：讀完立刻清掉照片（只留文字結果 1 小時給 App 拿），任何件最多放 24 小時
- **Sheet 寫入前重查列號**（避免兩台手機同時操作改錯列）

## Sheet 欄位（只能往後加）

**Cards 分頁**（一張名片一列）：`id, created_at, updated_at, name, name_alt, company, department, title, mobile, phone, fax, email, website, address, social, note, tags, photos(JSON), status, raw_text, company_id, nationality`（`company_id` 是 v0.3.0 加的第 21 欄、`nationality` 是 v0.3.1 加的第 22 欄）

**Companies 分頁**（一家公司一列，v0.3.0 起）：`id, created_at, updated_at, name, full_name, about, industry, relation, region, sales_type, material_source, products(JSON：[{name, tons}]), website, domains, note, tags, auto_fields`（`auto_fields`＝還沒被人改過的 AI 欄位，畫面標「自動產生」）

## 檔案地圖

| 檔案 | 用途 |
|------|------|
| `index.html`／`css/app.css`／`manifest.webmanifest`／`sw.js` | 外框、樣式、PWA、離線快取（network-first） |
| `js/config.js` | 版本、Client ID、收件櫃網址 |
| `js/app.js` | 畫面與事件（名片／公司清單、日曆、自訂排序、名片詳細／編輯、公司檔案／編輯、整理下拉選單、設定） |
| `js/store.js` | 名片＋公司檔案的狀態中心；`linkCompany` 自動歸屬公司 |
| `js/auth.js` | Google 登入（沿用 BroTrip 驗證過的寫法） |
| `js/google.js` | Drive／Sheets 存取 |
| `js/queue.js` | 上傳＋辨識佇列 |
| `js/cards.js` | 純邏輯：欄位、搜尋、正反面合併、vCard、公司檔案（配對、網域、下拉選單、改名）、自訂分組、日曆（有單元測試） |
| `js/ocr.js` | 放件＋輪詢收件櫃 |
| `js/camera.js` | App 內連拍相機 |
| `js/demo.js` | 試玩模式（`?demo=1`，不連 Google、假 AI） |
| `worker/src/index.js`／`worker/schema.sql` | 收件櫃 Worker＋D1 表結構（借 Guandan5 的 wrangler，無 npm 套件） |
| `runner/cardbox_runner.py`／`runner/cardbox_runner_launcher.bat` | 拿件小程式＋常駐啟動器 |
| `runner/company_profile.py` | 公司檔案草稿：看官網（只連公開網站）＋請 Claude 判斷全名／簡介／產業／地區＋本機快取 |
| `tools/setup_runner_secret.py` | 產生 RUNNER_SECRET（存 `~/.claude/secrets/cardbox_runner.env`＋設定到 Cloudflare） |
| `tools/write_bats.py` | 產生 CRLF＋ASCII 的 bat |
| `tests/cards.test.mjs`／`tests/companies.test.mjs` | 單元測試（名片／公司檔案、分組、日曆） |
| `tests/google.test.mjs` | 用假 Google API 模擬 v0.2.0 舊試算表，測升級（補分頁、補標題）與公司檔案增刪改 |
| `worker/smoke_test.py` | 收件櫃安全檢查（不花額度） |
| `worker/e2e_local.py` | 本機端到端（真的用一次 Claude） |

## 常駐服務（resident `CardBox`）

- 管理器：`scripts/resident_services_hidden.ps1 -Service CardBox`（catalog／visible_host 同步登記）；port 47960 單例鎖＋accept-drain；`replace_stale` 600 秒
- 心跳：`runner/logs/heartbeat.txt`（主迴圈每 5 秒，兩個工作執行緒 400 秒內都有跑完一輪才寫）；`_common/heartbeat.py` 門檻 2h
- 監看排程：`Batnini CardBox Watch` 每 30 分（:11／:41，隱藏）
- 改程式：存檔 10 秒後自動重載（batnini_reload，沒有正在讀的名片時才換版），不用重啟
- log：`runner/logs/runner.log`（輪替 1MB×3）、`runner/logs/launch.log`

## 驗證狀態（2026-10-27，v0.3.0）

- ✅ v0.3.1（2026-10-27）：單元測試 31/31（多國籍一題）；試玩模式驗過國籍「＋ 新增選項」→ 名片頁顯示 🌏、別張名片選單自動出現、整理選單頁有「國籍（名片）」；補查按鈕驗過刪掉公司檔案的舊名片會重建並補上簡介、查不到的分開報
- ✅ v0.3.0 單元測試 30/30：`node --test tests/cards.test.mjs tests/companies.test.mjs tests/google.test.mjs`（日曆那題要在台灣時區跑：前面加 `TZ=Asia/Taipei`）
- ✅ 假 Google API 模擬 v0.2.0 舊試算表：自動補 Companies 分頁＋兩個分頁標題、舊名片那一列不動、第二次打開不重建、公司增刪改寫對列
- ✅ 試玩模式端到端（v0.3.0）：6 張照片 → 5 張名片（正反面合併）＋4 個公司檔案（不同子網域的同公司歸成一家）；日曆（月份切換、點日期篩選）、自訂排序「＋地區」、公司清單＋關係篩選、搜「鋼桶」靠公司簡介找到人、名片改歸屬、公司編輯（新增下拉選項、需求產品兩列、改過的欄位拿掉「自動產生」）、整理選單改名（先列影響公司再確認）；瀏覽器零錯誤
- ✅ 公司檔案草稿真 Claude 實測：GREIF → Greif, Inc.／工業包裝／美國（看了官網，8.7 秒）；台積電 → 台灣積體電路製造股份有限公司／半導體／新竹市（7.7 秒）；同公司第二張走快取 0 秒；內網防護擋下 localhost／區網／Tailscale／雲端內部位址
- ✅ 真機（v0.2.0，2026-10-27）：手機登入、拍名片、Drive 資料夾＋試算表建立、辨識 5 張每張 5～10 秒
- ⏳ 未驗證：v0.3.0 在真 Google 試算表上的升級（要部署後用手機打開一次）

## 線上狀態

- App：`https://madeintw80.github.io/cardbox/`（repo `madeintw80/cardbox` public，Pages＝main／root），v0.3.1（2026-10-27 01:58 部署，實讀線上 config.js／sw.js／cards.js／app.js 都是新版；v0.3.0 是同日 01:46）
- 辨識主機：2026-10-27 起已經會回公司檔案草稿（舊 App 會忽略，不影響使用）
- 收件櫃：`https://cardbox-ocr.madeintw80.workers.dev`（D1 `cardbox-jobs`、KV `USAGE`）
- 機密：`RUNNER_SECRET`（已設）、`ALLOWED_EMAILS`（2026-10-27 Boss 雙擊 `worker/set_allowed_emails.bat` 設好朋友＋Boss 兩個 Gmail；要加人或換人就再雙擊一次，每次會整份蓋掉舊名單，所以要全部重打）
- ⚠️ 線上冒煙要帶瀏覽器 User-Agent（Cloudflare 會擋 Python 預設 UA，回 error code 1010）；拿件小程式用自訂 UA
- ⚠️ 部署後 10～40 秒內新舊版會交替（舊版路徑回 404），測試要等一下

## 部署（對外動作，每次先問 Boss）

- 收件櫃：`node <Guandan5>/node_modules/wrangler/bin/wrangler.js deploy --config worker/wrangler.jsonc`；改表結構先 `d1 execute cardbox-jobs --remote --file worker/schema.sql`
- App：升版三處同步（`js/config.js` VERSION ＋ `sw.js` CACHE ＋ `index.html`／`sw.js` 的 `?v=`）→ push → 實讀線上 `js/config.js` 版本

## 待辦／之後可以加

- 手動合併兩張名片、標籤篩選、「待補」名片篩選
- 合併兩個公司檔案（自動配對分成兩家時，現在要一張張名片改歸屬）
- 自訂排序同步到別台手機（現在存在手機本機）
