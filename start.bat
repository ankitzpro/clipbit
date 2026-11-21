@echo off
REM ClipBit one-click start for Windows (requires Docker Desktop running)
cd /d "%~dp0"
if not exist .env (
  copy .env.example .env >nul
  echo Created .env from .env.example - add your GEMINI_API_KEY and Google OAuth keys, then run this again.
  notepad .env
  exit /b
)
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo Docker failed to start ClipBit. Is Docker Desktop running?
  pause
  exit /b 1
)
echo.
echo ClipBit is starting at http://localhost:8080  (first start downloads the Whisper model, give it a minute)
timeout /t 5 >nul
start http://localhost:8080
