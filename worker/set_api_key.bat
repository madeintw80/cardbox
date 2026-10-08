@echo off
set NODE=C:\Users\User\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
set WRANGLER=C:\Users\User\projects\Guandan5\node_modules\wrangler\bin\wrangler.js
set CONFIG=C:\Users\User\projects\CardBox\worker\wrangler.jsonc
echo ============================================================
echo  CardBox OCR - set Claude API key
echo  Paste the key (starts with sk-ant-) and press Enter.
echo  The key is hidden while you type. It is stored only in Cloudflare.
echo ============================================================
"%NODE%" "%WRANGLER%" secret put ANTHROPIC_API_KEY --config "%CONFIG%"
echo.
echo Done. You can close this window.
pause
