@echo off
rem 사진정리.exe 만들기 (결과: dist\사진정리\사진정리.exe)
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv python -m venv .venv || goto :fail
for /f "delims=" %%v in ('.venv\Scripts\python -c "import sys;print(sys.version_info[1])"') do set PYMINOR=%%v
if %PYMINOR% GEQ 14 (
  echo [주의] Python 3.%PYMINOR% 입니다. 프로그램 창 기능이 동작하지 않을 수 있습니다.
  echo        Python 3.12 또는 3.13 설치 후 .venv 폴더를 지우고 아래 명령으로 다시 만드세요:
  echo        py -3.13 -m venv .venv
  echo.
)
.venv\Scripts\python -m pip install -r requirements.txt pyinstaller || goto :fail
.venv\Scripts\pyinstaller --noconfirm --clean --windowed --name 사진정리 --add-data "static;static" --collect-data imageio_ffmpeg app.py || goto :fail
rem build 폴더는 중간 파일이라 지운다 (실행 파일은 dist 폴더에 있음)
if exist build rmdir /s /q build
echo.
echo 완료: dist\사진정리\사진정리.exe
echo dist\사진정리 폴더를 통째로 원하는 곳에 복사해서 사용하세요. (exe만 따로 옮기면 실행되지 않습니다)
explorer "dist\사진정리"
pause
goto :eof
:fail
echo 빌드에 실패했습니다.
pause
