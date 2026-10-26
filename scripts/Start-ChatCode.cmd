@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0Start-ChatCode.ps1" %*
set "CHATCODE_EXIT=%ERRORLEVEL%"
if not "%CHATCODE_EXIT%"=="0" (
  echo ChatCode startup failed. Check the newest .tmp\logs\start-*.ndjson and admin logs.
  pause
)
exit /b %CHATCODE_EXIT%
