@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0"
call "%~dp0windows\run.cmd" windows\check.cjs %*
set "IZ2S_EXIT=%ERRORLEVEL%"
popd
if not "%IZ2S_NO_PAUSE%"=="1" pause
exit /b %IZ2S_EXIT%
