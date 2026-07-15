@echo off
cd /d "%~dp0"
set CONF_URL=https://87.242.117.240:8443
npm install
npx electron .
