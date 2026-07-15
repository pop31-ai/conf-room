@echo off
echo Building Android APK (API 26 / Android 8)...
cd /d "%~dp0"
if not exist "gradlew.bat" (
    echo Creating Gradle wrapper...
    gradle wrapper --gradle-version 8.4 2>nul
)
call gradlew.bat assembleDebug
echo.
echo APK: android-api26\app\build\outputs\apk\debug\app-debug.apk
pause
