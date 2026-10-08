@echo off
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
