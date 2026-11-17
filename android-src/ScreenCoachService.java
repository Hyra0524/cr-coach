package com.crcoach.app;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.Locale;

/**
 * 1) MediaProjection 으로 휴대폰 화면을 초당 fps 장 축소 캡처
 * 2) 게임 위에 떠 있는 코치 창(WebView, 같은 앱 화면을 #overlay 모드로 로드)에 프레임 전달
 * 3) 코치 창은 프레임에서 상대/내 카드, 내 엘릭서를 읽고 추천을 표시·음성 안내
 */
public class ScreenCoachService extends Service {
    public static final String ACTION_START = "com.crcoach.START";
    public static final String ACTION_STOP = "com.crcoach.STOP";
    public static final String PREFS = "crcoach_shared";
    private static final String CH = "cr_coach";
    public static volatile boolean running = false;

    private MediaProjection projection;
    private VirtualDisplay vdisplay;
    private ImageReader reader;
    private HandlerThread capThread;
    private Handler capHandler;
    private final Handler main = new Handler(Looper.getMainLooper());
    private WindowManager wm;
    private WebView web;
    private WindowManager.LayoutParams lp;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private volatile boolean pageReady = false;
    private volatile boolean busy = false;
    private int capW = 400, capH = 866, fps = 12;
    private String config = "{}";
    private String mode = "panel";

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) { shutdown(); return START_NOT_STICKY; }
        if (!ACTION_START.equals(intent.getAction()) || running) return START_NOT_STICKY;

        startAsForeground();
        int code = intent.getIntExtra("code", 0);
        Intent data = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra("data", Intent.class)
                : intent.getParcelableExtra("data");
        capW = Math.max(240, Math.min(720, intent.getIntExtra("width", 400)));
        fps = Math.max(2, Math.min(20, intent.getIntExtra("fps", 12)));
        String c = intent.getStringExtra("config");
        if (c != null) config = c;
        if (data == null) { shutdown(); return START_NOT_STICKY; }

        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        projection = mpm.getMediaProjection(code, data);
        if (projection == null) { shutdown(); return START_NOT_STICKY; }
        projection.registerCallback(new MediaProjection.Callback() {
            @Override public void onStop() { main.post(() -> shutdown()); }
        }, main);

        running = true;
        tts = new TextToSpeech(this, st -> {
            ttsReady = st == TextToSpeech.SUCCESS;
            if (ttsReady) { tts.setLanguage(Locale.KOREAN); tts.setSpeechRate(1.15f); }
        });
        showOverlay();
        startCapture();
        return START_NOT_STICKY;
    }

    private void startAsForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CH, "실시간 코치", NotificationManager.IMPORTANCE_LOW));
        }
        Intent stop = new Intent(this, ScreenCoachService.class).setAction(ACTION_STOP);
        PendingIntent pStop = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pOpen = PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
        Notification n = b.setContentTitle("CR 코치 실시간 분석 중")
                .setContentText("게임 화면을 읽고 있어요. 끝내려면 '종료'를 누르세요.")
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentIntent(pOpen)
                .addAction(new Notification.Action.Builder(null, "종료", pStop).build())
                .setOngoing(true).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(7, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(7, n);
    }

    /* ---------------- 화면 캡처 ---------------- */
    private void startCapture() {
        DisplayMetrics dm = getResources().getDisplayMetrics();
        int sw = dm.widthPixels, sh = dm.heightPixels;
        if (sw > sh) { int t = sw; sw = sh; sh = t; }       // 클래시로얄은 세로 화면
        capH = Math.round(capW * (sh / (float) sw));
        if ((capH & 1) == 1) capH++;
        reader = ImageReader.newInstance(capW, capH, PixelFormat.RGBA_8888, 2);
        capThread = new HandlerThread("cr-capture");
        capThread.start();
        capHandler = new Handler(capThread.getLooper());
        vdisplay = projection.createVirtualDisplay("cr-coach", capW, capH, dm.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, capHandler);
        capHandler.post(grab);
    }

    private final Runnable grab = new Runnable() {
        @Override public void run() {
            if (!running) return;
            long t0 = System.currentTimeMillis();
            try {
                if (pageReady && !busy) {
                    Image img = reader.acquireLatestImage();
                    if (img != null) {
                        // 캡처 시각 → 코치 창이 지연을 보정 (이미지 자체 시각이 정상 범위면 그걸, 아니면 지금)
                        final long nowNs = System.nanoTime(), ts = img.getTimestamp();
                        final long capAt = (ts > 0 && nowNs - ts >= 0 && nowNs - ts < 1000000000L) ? ts : nowNs;
                        final int fw = img.getWidth(), fh = img.getHeight();
                        final String b64 = encode(img);
                        img.close();
                        if (b64 != null) {
                            busy = true;
                            main.post(() -> {
                                if (web == null) { busy = false; return; }
                                // 코치 창 위치(캡처에선 검게 나옴) → 인식에서 그 영역 제외
                                String mask = "0,0,0,0";
                                if (!"full".equals(mode) && web.getWidth() > 0) {
                                    DisplayMetrics dm = getResources().getDisplayMetrics();
                                    float sw = Math.min(dm.widthPixels, dm.heightPixels), sh = Math.max(dm.widthPixels, dm.heightPixels);
                                    mask = (lp.x / sw) + "," + (lp.y / sh) + "," + (web.getWidth() / sw) + "," + (web.getHeight() / sh);
                                }
                                long age = (System.nanoTime() - capAt) / 1000000L;
                                String js = "window.__crFrame&&window.__crFrame('data:image/jpeg;base64," + b64 + "'," + fw + "," + fh + "," + age + "," + mask + ")";
                                web.evaluateJavascript(js, v -> busy = false);
                            });
                        }
                    }
                } else {
                    Image img = reader.acquireLatestImage();   // 버퍼가 쌓이지 않도록 비움
                    if (img != null) img.close();
                }
            } catch (Throwable ignored) { busy = false; }
            long wait = Math.max(10, 1000 / fps - (System.currentTimeMillis() - t0));
            if (capHandler != null) capHandler.postDelayed(this, wait);
        }
    };

    private Bitmap bmp;
    private final ByteArrayOutputStream jpg = new ByteArrayOutputStream(64 * 1024);

    private String encode(Image img) {
        Image.Plane p = img.getPlanes()[0];
        ByteBuffer buf = p.getBuffer();
        int pxStride = p.getPixelStride(), rowStride = p.getRowStride();
        int w = img.getWidth(), h = img.getHeight();
        int bw = rowStride / pxStride;
        if (bmp == null || bmp.getWidth() != bw || bmp.getHeight() != h) {
            if (bmp != null) bmp.recycle();
            bmp = Bitmap.createBitmap(bw, h, Bitmap.Config.ARGB_8888);
        }
        buf.rewind();
        bmp.copyPixelsFromBuffer(buf);
        Bitmap out = bw == w ? bmp : Bitmap.createBitmap(bmp, 0, 0, w, h);
        jpg.reset();
        out.compress(Bitmap.CompressFormat.JPEG, 68, jpg);
        if (out != bmp) out.recycle();
        return Base64.encodeToString(jpg.toByteArray(), Base64.NO_WRAP);
    }

    /* ---------------- 게임 위 코치 창 ---------------- */
    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void showOverlay() {
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        lp = new WindowManager.LayoutParams(dp(300), dp(214), type, baseFlags(), PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = dp(8);
        lp.y = dp(28);

        // 같은 출처(https://localhost)로 열어서 본 앱과 저장소(덱·학습 데이터)를 공유
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain("localhost")
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web = new WebView(this);
        web.setBackgroundColor(0);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "CRNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return loader.shouldInterceptRequest(r.getUrl());
            }
            @Override public void onPageFinished(WebView v, String url) { pageReady = true; }
        });
        web.loadUrl("https://localhost/public/index.html#overlay");
        wm.addView(web, lp);
    }

    /** 코치 창은 포커스를 가져가지 않고, 창 밖 터치는 게임으로 그대로 전달.
     *  FLAG_SECURE: 코치 창 자체는 캡처에서 검게 처리돼 인식 노이즈가 생기지 않음 */
    private int baseFlags() {
        return WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | WindowManager.LayoutParams.FLAG_SECURE;
    }

    private void applyMode(String m) {
        if (web == null || wm == null) return;
        mode = m;
        switch (m) {
            case "bubble": lp.width = dp(64); lp.height = dp(64); lp.flags = baseFlags(); break;
            case "full":   // 영역 맞추기: 전체 화면을 덮고 터치를 받음 (캡처에선 검게 → 마지막 프레임으로 맞춤)
                lp.width = WindowManager.LayoutParams.MATCH_PARENT; lp.height = WindowManager.LayoutParams.MATCH_PARENT;
                lp.x = 0; lp.y = 0; lp.flags = baseFlags() & ~WindowManager.LayoutParams.FLAG_SECURE; break;
            case "tall":   lp.width = dp(300); lp.height = dp(380); lp.flags = baseFlags(); break;
            default:       lp.width = dp(300); lp.height = dp(214); lp.flags = baseFlags();
        }
        wm.updateViewLayout(web, lp);
    }

    public class Bridge {
        @JavascriptInterface public String getConfig() { return config; }
        @JavascriptInterface public int getFps() { return fps; }
        @JavascriptInterface public String getMode() { return mode; }
        @JavascriptInterface public void moveBy(final float dx, final float dy) {
            main.post(() -> {
                if (web == null || "full".equals(mode)) return;
                DisplayMetrics dm = getResources().getDisplayMetrics();
                lp.x = Math.max(0, Math.min(dm.widthPixels - dp(48), lp.x + Math.round(dx)));
                lp.y = Math.max(0, Math.min(dm.heightPixels - dp(48), lp.y + Math.round(dy)));
                wm.updateViewLayout(web, lp);
            });
        }
        @JavascriptInterface public void setMode(final String m) { main.post(() -> applyMode(m)); }
        @JavascriptInterface public void speak(String text) {
            if (ttsReady && text != null) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "cr");
        }
        @JavascriptInterface public void saveShared(String json) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("shared", json).apply();
        }
        @JavascriptInterface public void close() { main.post(() -> shutdown()); }
        @JavascriptInterface public void openApp() {
            main.post(() -> {
                Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
                if (i != null) { i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(i); }
            });
        }
    }

    private void shutdown() {
        running = false;
        pageReady = false;
        try { if (capHandler != null) capHandler.removeCallbacksAndMessages(null); } catch (Throwable ignored) {}
        try { if (vdisplay != null) vdisplay.release(); } catch (Throwable ignored) {}
        try { if (reader != null) reader.close(); } catch (Throwable ignored) {}
        try { if (projection != null) projection.stop(); } catch (Throwable ignored) {}
        try { if (capThread != null) capThread.quitSafely(); } catch (Throwable ignored) {}
        try { if (web != null && wm != null) { wm.removeView(web); web.destroy(); } } catch (Throwable ignored) {}
        try { if (tts != null) tts.shutdown(); } catch (Throwable ignored) {}
        vdisplay = null; reader = null; projection = null; capThread = null; capHandler = null; web = null; tts = null;
        stopForeground(true);
        stopSelf();
    }

    @Override public void onDestroy() { if (running) shutdown(); super.onDestroy(); }
}
