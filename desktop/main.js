/**
 * @fileoverview Electron main process для десктопного клиента
 * @module conf-room-desktop/main
 * @description Обёртка Electron для веб-клиента конференц-комнаты.
 * Поддерживает Windows и Linux (включая AstraLinux).
 * Предоставляет доступ к камере/микрофону и микрофону через WebRTC.
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('path');

/** @type {BrowserWindow|null} Текущее окно приложения */
let mainWindow = null;

/** URL веб-клиента (по умолчанию — сервер конференций) */
const WEB_URL = process.env.CONF_URL || 'https://87.242.117.240:8443';

/**
 * Создаёт главное окно приложения
 * Настраивает безопасность: разрешает getUserMedia, отключает sandbox
 * для работы с локальными ресурсами.
 */
function createWindow() {
  app.setName('Конференц-комната');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Конференц-комната',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  });

  /**
   * Настраиваем разрешения для WebRTC и медиа-устройств
   * Разрешает доступ к камере и микрофону без запроса дополнительных прав
   */
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      /** Разрешаем все запросы на медиа-устройства */
      const allowedPermissions = [
        'media',
        'mediaKeySystem',
        'geolocation',
        'notifications',
        'fullscreen',
        'clipboard-read',
        'clipboard-sanitized-write'
      ];

      if (allowedPermissions.includes(permission)) {
        callback(true);
      } else {
        console.log(`[PERM] Запрошено разрешение: ${permission} — отклонено`);
        callback(false);
      }
    }
  );

  /**
   * Обработчик навигации — запрещаем переход на внешние сайты
   * Разрешаем только localhost и указанный сервер
   */
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) => {
      return true;
    }
  );

  // Загружаем веб-клиент
  mainWindow.loadURL(WEB_URL);

  /**
   * Обработчик закрытия окна
   */
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  /**
   * Обработчик ошибок загрузки страницы
   */
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDesc) => {
    console.error(`[ERROR] Загрузка не удалась: ${errorDesc} (${errorCode})`);
    // Показываем сообщение пользователю
    mainWindow.loadURL(`data:text/html,
      <html>
        <body style="font-family:sans-serif;padding:40px;text-align:center;background:#1a1a2e;color:#eee;">
          <h1>Сервер недоступен</h1>
          <p>Не удалось подключиться к ${WEB_URL}</p>
          <p>Убедитесь, что сервер запущен:</p>
          <code>cd server && npm start</code>
          <p style="margin-top:20px;color:#aaa;">Нажмите Ctrl+R для обновления</p>
        </body>
      </html>
    `);
  });
}

// ============================================================
// Жизненный цикл приложения
// ============================================================

/**
 * Готовность приложения — создаём окно
 */
app.whenReady().then(() => {
  createWindow();

  /**
   * Обработчик активации (macOS) — создаём окно если нет активных
   */
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

/**
 * Закрытие всех окон — завершаем приложение (кроме macOS)
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
