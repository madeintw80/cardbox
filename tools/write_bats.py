# 產生名片盒用的 .bat（必須 CRLF＋純 ASCII，否則 cmd 會亂碼或跑錯）
# 用法：python C:/Users/User/projects/CardBox/tools/write_bats.py
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

WRANGLER_HEADER = r"""@echo off
set NODE=C:\Users\User\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
set WRANGLER=C:\Users\User\projects\Guandan5\node_modules\wrangler\bin\wrangler.js
set CONFIG=C:\Users\User\projects\CardBox\worker\wrangler.jsonc
"""

# 2026-10-08：改用 Boss 電腦的 Claude 訂閱後，不再需要 set_api_key.bat
BATS = {
    "worker/set_allowed_emails.bat": WRANGLER_HEADER + r"""echo ============================================================
echo  CardBox OCR - set allowed Gmail addresses
echo  Type ALL allowed addresses, comma separated, then press Enter.
echo  Example: friend@gmail.com,boss@gmail.com
echo  (This replaces the old list.)
echo ============================================================
"%NODE%" "%WRANGLER%" secret put ALLOWED_EMAILS --config "%CONFIG%"
echo.
echo Done. You can close this window.
pause
""",
    # 常駐啟動器（resident_services_hidden.ps1 -Service CardBox 用）。照 XianxiaSaga launcher：
    # 非 0 結束（當機、改碼重載 exit 3）→ 5 秒後重開；exit 0（已有一支在跑／Ctrl+C）→ 不重開
    # 結尾不能有 pause：隱藏啟動時會留下等按鍵的孤兒 cmd.exe
    "runner/cardbox_runner_launcher.bat": r"""@echo off
REM CardBox runner launcher (ASCII only, CRLF). Auto-restart loop for resident_services -Service CardBox.
REM Any NON-ZERO exit (crash, code-reload exit 3, Stop-Process) restarts after 5s.
REM Exit 0 (another instance holds lock 47960, or clean stop) ends the loop.
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
title CardBoxRunner
cd /d C:\Users\User\projects\CardBox\runner
if not exist C:\Users\User\projects\CardBox\runner\logs mkdir C:\Users\User\projects\CardBox\runner\logs
:loop
echo [CardBoxRunner] start at %date% %time% >> C:\Users\User\projects\CardBox\runner\logs\launch.log
C:\Users\User\AppData\Local\Python\pythoncore-3.14-64\python.exe cardbox_runner.py >> C:\Users\User\projects\CardBox\runner\logs\launch.log 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [CardBoxRunner] exited with code %ERRORLEVEL%, restart in 5s >> C:\Users\User\projects\CardBox\runner\logs\launch.log
  ping -n 6 127.0.0.1 >nul 2>&1
  goto loop
)
echo [CardBoxRunner] clean exit, not restarting >> C:\Users\User\projects\CardBox\runner\logs\launch.log
""",
}

for rel, text in BATS.items():
    text.encode("ascii")  # 有非 ASCII 字元就直接報錯
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.replace("\r\n", "\n").replace("\n", "\r\n").encode("ascii"))
    print("wrote", path)
