package com.conf.room;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * @fileoverview Android WebView-обёртка для конференц-комнаты
 * @class MainActivity
 * @description Загружает веб-клиент в WebView.
 * Разрешает доступ к камере, микрофону, WebRTC.
 * Поддерживает Android 8 (API 26) и выше.
 */
public class MainActivity extends Activity {

    /** WebView для отображения веб-клиента */
    private WebView webView;

    /** Код разрешения на камеру и микрофон */
    private static final int PERMISSION_REQUEST_CODE = 100;

    /** URL веб-клиента (по умолчанию — локальный сервер) */
    private static final String DEFAULT_URL = "http://82.242.117.240:8080";

    /**
     * Инициализация Activity
     * Настраивает WebView, запрашивает разрешения, загружает URL.
     *
     * @param savedInstanceState Сохранённое состояние (null при первом запуске)
     */
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Полноэкранный режим
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }

        // Запрашиваем разрешения
        requestPermissions();

        // Инициализируем WebView
        initWebView();
    }

    /**
     * Запрашивает разрешения на камеру и микрофон
     * Необходимы для работы WebRTC
     */
    private void requestPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            String[] permissions = {
                    Manifest.permission.CAMERA,
                    Manifest.permission.RECORD_AUDIO,
                    Manifest.permission.MODIFY_AUDIO_SETTINGS
            };

            boolean needRequest = false;
            for (String perm : permissions) {
                if (checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) {
                    needRequest = true;
                    break;
                }
            }

            if (needRequest) {
                requestPermissions(permissions, PERMISSION_REQUEST_CODE);
            }
        }
    }

    /**
     * Настраивает WebView с поддержкой WebRTC и медиа-устройств
     */
    @SuppressLint("SetJavaScriptEnabled")
    private void initWebView() {
        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();

        // JavaScript обязателен для WebRTC
        settings.setJavaScriptEnabled(true);

        // Включаем DOM Storage
        settings.setDomStorageEnabled(true);

        // Разрешаем доступ к файлам
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);

        // Включаем медиа-автовоспроизведение
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Кэширование
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Масштабирование для мобильных
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);

        /**
         * WebViewClient — обрабатывает навигацию
         * Все ссылки открываются внутри WebView
         */
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                view.loadUrl(url);
                return true;
            }
        });

        /**
         * WebChromeClient — обрабатывает запросы разрешений для WebRTC
         * Разрешает доступ к камере и микрофону из JavaScript
         */
        webView.setWebChromeClient(new WebChromeClient() {
            /**
             * Обрабатывает запрос разрешения на медиа-устройства
             * @param view WebView, запросивший разрешение
             * @param request Запрос разрешения (камера, микрофон)
             * @param callback Callback для предоставления/отклонения разрешения
             */
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        // Разрешаем все запросы на медиа-устройства
                        request.grant(request.getResources());
                    }
                });
            }
        });

        // Загружаем веб-клиент
        webView.loadUrl(DEFAULT_URL);
    }

    /**
     * Обработка результата запроса разрешений
     *
     * @param requestCode Код запроса
     * @param permissions Массив запрошенных разрешений
     * @param grantResults Результаты предоставления разрешений
     */
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == PERMISSION_REQUEST_CODE) {
            for (int i = 0; i < permissions.length; i++) {
                if (grantResults[i] == PackageManager.PERMISSION_GRANTED) {
                    System.out.println("[PERM] Разрешено: " + permissions[i]);
                } else {
                    System.out.println("[PERM] Отклонено: " + permissions[i]);
                }
            }
        }
    }

    /**
     * Обработка нажатия кнопки "Назад"
     * Если WebView может вернуться назад — делает это,
     * иначе закрывает приложение
     */
    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    /**
     * Пауза приложения — приостанавливаем WebView
     */
    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.onPause();
        }
    }

    /**
     * Возобновление приложения — возобновляем WebView
     */
    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
    }

    /**
     * Уничтожение Activity — освобождаем ресурсы WebView
     */
    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
