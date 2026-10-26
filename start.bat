@echo off
cd /d "%~dp0"
echo Starting HARVESTIQ...
start "" http://localhost:8080
node serve.mjs
pause
