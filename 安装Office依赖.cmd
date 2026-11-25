@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv-office\Scripts\python.exe" (
  python -m venv .venv-office
  if errorlevel 1 goto failed
)
.venv-office\Scripts\python.exe -m pip install -r requirements-office.txt
if errorlevel 1 goto failed
echo Python 依赖已安装。可选 office-tool 的安装方式见 README。
pause
exit /b 0
:failed
echo 安装失败，请检查 Python 和网络后重试。
pause
exit /b 1
