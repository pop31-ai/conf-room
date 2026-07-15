@echo off
setlocal

set SERVER=user1@87.242.117.240
set KEY=%~dp0id_rsa
set REMOTE=/opt/conf-server

echo ============================================
echo   Deploy to %SERVER%
echo ============================================

echo [1/5] Copy server files...
scp -i "%KEY%" -o StrictHostKeyChecking=no "%~dp0server\server.js" "%~dp0server\package.json" %SERVER%:%REMOTE%/

echo [2/5] Copy web files...
scp -i "%KEY%" -o StrictHostKeyChecking=no -r "%~dp0web\*" %SERVER%:%REMOTE%/web/

echo [3/5] Install dependencies...
ssh -i "%KEY%" -o StrictHostKeyChecking=no %SERVER% "cd %REMOTE% && npm install --production 2>&1"

echo [4/5] Restart service...
ssh -i "%KEY%" -o StrictHostKeyChecking=no %SERVER% "sudo systemctl restart conf-server && sleep 1 && sudo systemctl status conf-server --no-pager"

echo [5/5] Done!
echo ============================================
echo   https://87.242.117.240:8443
echo ============================================

pause
