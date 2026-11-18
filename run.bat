@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv (
  echo 처음 실행: 필요한 패키지를 설치합니다...
  python -m venv .venv || goto :nopython
  .venv\Scripts\python -m pip install -r requirements.txt || goto :fail
)
.venv\Scripts\python app.py %*
goto :eof
:nopython
echo Python 3.10 이상을 설치한 뒤 다시 실행하세요: https://www.python.org/downloads/
pause
goto :eof
:fail
echo 패키지 설치에 실패했습니다.
pause
