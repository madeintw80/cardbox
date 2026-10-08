@echo off
set NODE=C:\Users\User\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
set WRANGLER=C:\Users\User\projects\Guandan5\node_modules\wrangler\bin\wrangler.js
set CONFIG=C:\Users\User\projects\CardBox\worker\wrangler.jsonc
echo ============================================================
echo  CardBox OCR - set allowed Gmail addresses
echo  Type ALL allowed addresses, comma separated, then press Enter.
echo  Example: friend@gmail.com,boss@gmail.com
echo  (This replaces the old list.)
echo ============================================================
"%NODE%" "%WRANGLER%" secret put ALLOWED_EMAILS --config "%CONFIG%"
echo.
echo Done. You can close this window.
pause
