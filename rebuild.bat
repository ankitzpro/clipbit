@echo off
REM Rebuilds ClipBit from the latest code, restarts it, and writes diagnostics to rebuild-log.txt
cd /d "%~dp0"
echo Rebuilding ClipBit - this takes a few minutes. Output goes to rebuild-log.txt
echo ==== START %date% %time% > rebuild-log.txt
docker compose build --no-cache app worker >> rebuild-log.txt 2>&1
echo ==== BUILD EXIT %errorlevel% >> rebuild-log.txt
docker compose build whisper >> rebuild-log.txt 2>&1
echo ==== WHISPER BUILD EXIT %errorlevel% >> rebuild-log.txt
docker compose up -d >> rebuild-log.txt 2>&1
docker compose up -d --force-recreate whisper app worker >> rebuild-log.txt 2>&1
timeout /t 40 /nobreak >nul
echo ==== CODE CHECK worker / app (should be 1 or more) >> rebuild-log.txt
docker compose exec -T worker grep -c contactSheet /app/server/dist/services/ai/ollama.js >> rebuild-log.txt 2>&1
docker compose exec -T app grep -c contactSheet /app/server/dist/services/ai/ollama.js >> rebuild-log.txt 2>&1
echo ==== STATUS >> rebuild-log.txt
docker compose ps -a >> rebuild-log.txt 2>&1
echo ==== WHISPER >> rebuild-log.txt
docker compose logs --tail 40 whisper >> rebuild-log.txt 2>&1
echo ==== LOGS >> rebuild-log.txt
docker compose logs --tail 80 worker app >> rebuild-log.txt 2>&1
echo ==== DONE %date% %time% >> rebuild-log.txt
echo Done. You can close this window.
