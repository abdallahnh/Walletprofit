@echo off
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo Node.js is not installed. Please install Node.js 18+ from https://nodejs.org
  exit /b 1
)

echo Installing dependencies...
call npm install || exit /b 1

echo Building installers...
call npm run dist || exit /b 1

echo Done. Check the dist\ folder.