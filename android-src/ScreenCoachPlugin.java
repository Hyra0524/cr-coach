package com.crcoach.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 휴대폰 화면을 실시간으로 읽고 게임 위에 코치 창을 띄우는 플러그인 */
@CapacitorPlugin(name = "ScreenCoach")
public class ScreenCoachPlugin extends Plugin {

    private String pendingConfig = "{}";
    private int pendingWidth = 360;
    private int pendingFps = 8;

    @PluginMethod
    public void hasOverlayPermission(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(getContext()));
        r.put("running", ScreenCoachService.running);
        call.resolve(r);
    }

    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(getContext())) {
            Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName()));
            startActivityForResult(call, i, "onOverlayResult");
        } else {
            JSObject r = new JSObject(); r.put("granted", true); call.resolve(r);
        }
    }

    @ActivityCallback
    private void onOverlayResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject r = new JSObject();
        r.put("granted", Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(getContext())) {
            call.reject("overlay");
            return;
        }
        pendingConfig = call.getString("config", "{}");
        pendingWidth = call.getInt("width", 360);
        pendingFps = call.getInt("fps", 8);
        MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        startActivityForResult(call, mpm.createScreenCaptureIntent(), "onProjection");
    }

    @ActivityCallback
    private void onProjection(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("denied");
            return;
        }
        Intent svc = new Intent(getContext(), ScreenCoachService.class);
        svc.setAction(ScreenCoachService.ACTION_START);
        svc.putExtra("code", result.getResultCode());
        svc.putExtra("data", result.getData());
        svc.putExtra("width", pendingWidth);
        svc.putExtra("fps", pendingFps);
        svc.putExtra("config", pendingConfig);
        ContextCompat.startForegroundService(getContext(), svc);
        // 사용자가 바로 게임으로 넘어가도록 앱을 뒤로 보냄
        Activity a = getActivity();
        if (a != null) a.moveTaskToBack(true);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent svc = new Intent(getContext(), ScreenCoachService.class);
        svc.setAction(ScreenCoachService.ACTION_STOP);
        getContext().startService(svc);
        call.resolve();
    }

    @PluginMethod
    public void getShared(PluginCall call) {
        SharedPreferences sp = getContext().getSharedPreferences(ScreenCoachService.PREFS, Context.MODE_PRIVATE);
        JSObject r = new JSObject();
        r.put("json", sp.getString("shared", ""));
        call.resolve(r);
    }

    @PluginMethod
    public void clearShared(PluginCall call) {
        getContext().getSharedPreferences(ScreenCoachService.PREFS, Context.MODE_PRIVATE).edit().remove("shared").apply();
        call.resolve();
    }
}
