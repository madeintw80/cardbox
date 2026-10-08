# 名片盒 CardBox 📇

拍下名片，AI 自動整理成聯絡人。照片和資料都存在**你自己的 Google 雲端硬碟**。

網址：`https://madeintw80.github.io/cardbox/`（部署後）

## 怎麼用（給使用者）

1. **用 Safari（iPhone）或 Chrome（Android）打開網址**。從 LINE 點開的話，要先複製網址改用瀏覽器開，Google 不允許在 LINE 裡登入
2. 按「用 Google 帳號登入」。授權畫面會寫「BroTrip」，那是開發者另一個 App 的名字，可以放心按允許，記得**勾選 Google 雲端硬碟**
3. 加到主畫面，之後就像 App 一樣：
   - iPhone：Safari 下方「分享」⬆️ →「加入主畫面」
   - Android：Chrome 右上角 ⋮ →「加到主畫面」
4. 開始存名片：
   - **📷 拍名片**：對準框框按快門，可以一直拍，拍完按「完成」
   - **🖼 從相簿選**：一次選很多張
   - 中英雙面名片兩面都拍，會自動合併成一張
5. 點名片可以直接撥號、寄信、開地圖，或「加入手機通訊錄」

你的資料在雲端硬碟的「**名片盒 CardBox**」資料夾裡，「名片盒資料」試算表可以直接打開來改。

## 給開發者

規格、決策、檔案地圖、部署步驟都在 [PLAN.md](PLAN.md)。

- 試玩模式（不連 Google、假 AI）：網址加 `?demo=1`
- 單元測試：`node --test tests/cards.test.mjs`
- 中繼站安全檢查：`python worker/smoke_test.py [網址]`
- 本機預覽：`python -m http.server 3480 -d .`
