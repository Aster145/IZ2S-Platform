@echo off
setlocal DisableDelayedExpansion
set "IZ2S_NODE=%~dp0..\data\runtime\node\node.exe"
if exist "%IZ2S_NODE%" goto run
where.exe node.exe >nul 2>&1
if errorlevel 1 goto missing
set "IZ2S_NODE=node.exe"
:run
"%IZ2S_NODE%" %*
exit /b %ERRORLEVEL%
:missing
echo ERROR: Node.js was not found.
echo Extract the complete Windows package again, including data\runtime\node.
echo The source-only fallback requires Node.js 22 or later in PATH.
exit /b 1
