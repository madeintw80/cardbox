# 產生中繼站設定用的 .bat（必須 CRLF＋純 ASCII，否則 cmd 會亂碼或跑錯）
# 用法：python C:/Users/User/projects/CardBox/tools/write_bats.py
from pathlib import Path

WORKER = Path(__file__).resolve().parent.parent / "worker"

HEADER = r"""@echo off
set NODE=C:\Users\User\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
set WRANGLER=C:\Users\User\projects\Guandan5\node_modules\wrangler\bin\wrangler.js
set CONFIG=C:\Users\User\projects\CardBox\worker\wrangler.jsonc
"""

BATS = {
    "set_api_key.bat": HEADER + r"""echo ============================================================
echo  CardBox OCR - set Claude API key
echo  Paste the key (starts with sk-ant-) and press Enter.
echo  The key is hidden while you type. It is stored only in Cloudflare.
echo ============================================================
"%NODE%" "%WRANGLER%" secret put ANTHROPIC_API_KEY --config "%CONFIG%"
echo.
echo Done. You can close this window.
pause
""",
    "set_allowed_emails.bat": HEADER + r"""echo ============================================================
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
}

for name, text in BATS.items():
    text.encode("ascii")  # 有非 ASCII 字元就直接報錯
    (WORKER / name).write_bytes(text.replace("\r\n", "\n").replace("\n", "\r\n").encode("ascii"))
    print("wrote", WORKER / name)
