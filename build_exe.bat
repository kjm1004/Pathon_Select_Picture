@echo off
rem 사진정리.exe 만들기 (결과: dist\사진정리\사진정리.exe)
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv python -m venv .venv || goto :fail
.venv\Scripts\python -m pip install -r requirements.txt pyinstaller || goto :fail
.venv\Scripts\pyinstaller --noconfirm --clean --windowed --name 사진정리 --add-data "static;static" app.py || goto :fail
echo.
echo 완료: dist\사진정리\사진정리.exe
echo dist\사진정리 폴더 전체를 원하는 곳에 복사해서 사용하세요.
pause
goto :eof
:fail
echo 빌드에 실패했습니다.
pause
