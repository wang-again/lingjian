@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22.23.5、24.22.3 或更新的 LTS 版本，然后重新运行。
  pause
  exit /b 1
)
if exist "node_modules\electron\cli.js" (
  node -e "const installed = require('./node_modules/electron/package.json').version; const locked = require('./package-lock.json').packages['node_modules/electron'].version; process.exitCode = installed === locked ? 0 : 1" >nul 2>nul
  if not errorlevel 1 goto start
)
echo 正在安装桌面版依赖……
call npm.cmd ci --include=dev
if errorlevel 1 goto failed
:start
echo 正在启动灵笺文档工作台……
call npm.cmd start
if errorlevel 1 goto failed
exit /b 0
:failed
pause
exit /b 1
