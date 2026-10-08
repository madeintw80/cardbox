-- 名片盒收件櫃（Cloudflare D1）
-- 建表：wrangler d1 execute cardbox-jobs --remote --file schema.sql --config wrangler.jsonc
-- 重複執行不會壞（IF NOT EXISTS）

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,   -- 隨機 UUID
  owner       TEXT NOT NULL,      -- 使用者 Email 的雜湊（不存原文）
  status      TEXT NOT NULL,      -- pending 等電腦拿｜working 電腦處理中｜done 讀好了｜error 失敗
  media_type  TEXT NOT NULL,
  image       TEXT,               -- 照片 base64；讀完就清成 NULL
  result      TEXT,               -- 讀好的欄位（JSON）
  error       TEXT,
  created_at  INTEGER NOT NULL,   -- 毫秒時間戳
  claimed_at  INTEGER,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs (status, created_at);

-- 雜項：runner_seen＝電腦最後一次來拿件的時間（判斷電腦在不在線）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
