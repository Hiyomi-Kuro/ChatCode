@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0Stop-ChatCode.ps1"
set "CHATCODE_EXIT=%ERRORLEVEL%"
if not "%CHATCODE_EXIT%"=="0" (
  echo ChatCode shutdown failed. Check the newest .tmp\logs\stop-*.ndjson and admin logs.
  pause
)
exit /b %CHATCODE_EXIT%
