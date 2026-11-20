@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv (
  echo 처음 실행: 필요한 패키지를 설치합니다. 잠시 기다려 주세요...
  python -m venv .venv || goto :nopython
  .venv\Scripts\python -m pip install -r requirements.txt || goto :fail
)
rem 영상편집 프로그램(video_editor 폴더)과 그 패키지(PySide6) 준비
if not exist video_editor\main.py git submodule update --init --recursive >nul 2>&1
if exist video_editor\requirements.txt (
  .venv\Scripts\python -c "import PySide6" >nul 2>&1 || .venv\Scripts\python -m pip install -r video_editor\requirements.txt
)
rem 콘솔 창 없이 프로그램 창만 띄운다. 오류 기록: %USERPROFILE%\.photo-cleaner\app.log
start "" .venv\Scripts\pythonw.exe app.py %*
goto :eof
:nopython
echo Python 3.10~3.13 을 설치한 뒤 다시 실행하세요: https://www.python.org/downloads/
pause
goto :eof
:fail
echo 패키지 설치에 실패했습니다. .venv 폴더를 지우고 다시 실행해 보세요.
pause
