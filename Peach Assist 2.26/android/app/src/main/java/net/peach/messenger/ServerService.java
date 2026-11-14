package net.peach.messenger;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.PendingIntent;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.res.AssetManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Holds the server open while the phone is in a pocket.
 *
 * Three things keep it alive, and all three are needed:
 *   - a foreground service, so Android does not simply stop the process;
 *   - a partial wake lock, so the CPU is not parked with the screen off;
 *   - a multicast lock, so SSDP can hear the router for UPnP.
 */
public class ServerService extends Service {

    static {
        System.loadLibrary("native-lib");
        System.loadLibrary("node");
    }

    public static final String CHANNEL_ID = "peach_server";
    private static final String UPDATE_CHANNEL = "peach_update";
    private static final int UPDATE_NOTICE = 4711;
    private volatile boolean watching;
    public static final int NOTIFICATION_ID = 1;
    public static final int PORT = 3000;

    private static final AtomicBoolean started = new AtomicBoolean(false);

    private PowerManager.WakeLock wakeLock;
    private WifiManager.MulticastLock multicastLock;
    private Handler hoursHandler;

    /**
     * Work hours. While the business is closed the server stays reachable, but the
     * phone is allowed to sleep: holding a partial wake lock around the clock kept
     * the CPU awake and made the handset run hot. The server answers
     * /api/app-state, so this simply follows whatever the administrator set.
     */
    private final Runnable hoursCheck = new Runnable() {
        @Override public void run() {
            new Thread(ServerService.this::checkWorkHours, "peach-hours").start();
            if (hoursHandler != null) hoursHandler.postDelayed(this, 10 * 60 * 1000);
        }
    };

    public native Integer startNodeWithArguments(String[] arguments);

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, buildNotification());
        holdLocks();
        startHoursWatch();
        if (!started.getAndSet(true)) {
            new Thread(this::runNode, "peach-node").start();
        }
        watchUpdateRequests();
        return START_STICKY;
    }

    private Notification buildNotification() {
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Server", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Keeps the messenger running");
            nm.createNotificationChannel(channel);
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        return builder
                .setContentTitle("Peach Assist is running")
                .setContentText("Port " + PORT + " — open the app to use it")
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setOngoing(true)
                .build();
    }

    /**
     * Watches for an update the panel queued.
     *
     * The admin page may be open in a browser, where nothing can install an
     * APK. The server writes the request to a file instead; this picks it up and
     * offers it as a notification, because a background service is not allowed
     * to open the installer window by itself.
     */
    private void watchUpdateRequests() {
        if (watching) return;
        watching = true;
        new Thread(() -> {
            File request = new File(getFilesDir(), "update-request.json");
            long seen = 0;
            while (true) {
                try {
                    Thread.sleep(5000);
                } catch (InterruptedException e) {
                    return;
                }
                if (!request.exists()) continue;
                try {
                    String text = readFile(request);
                    String atText = field(text, "at");
                    String url = field(text, "url");
                    if (atText == null || url == null) continue;
                    long at = Long.parseLong(atText);
                    if (at <= seen || !url.startsWith("http")) continue;
                    seen = at;
                    // The request is a one-shot order: handled, then gone, so a
                    // restart cannot offer the same update again.
                    request.delete();
                    offerUpdate(Updater.prepare(this, url));
                } catch (Exception e) {
                    Log.w("PEACH", "update request: " + e);
                }
            }
        }, "peach-updates").start();
    }

    /** Just enough JSON reading for two fields, with no parser on the classpath. */
    private static String field(String text, String key) {
        int at = text.indexOf('"' + key + '"');
        if (at < 0) return null;
        int colon = text.indexOf(':', at + key.length() + 2);
        if (colon < 0) return null;
        if ("at".equals(key)) {
            int start = colon + 1;
            while (start < text.length() && !Character.isDigit(text.charAt(start))) start++;
            int end = start;
            while (end < text.length() && Character.isDigit(text.charAt(end))) end++;
            return start == end ? null : text.substring(start, end);
        }
        int open = text.indexOf('"', colon + 1);
        if (open < 0) return null;
        int close = text.indexOf('"', open + 1);
        return close < 0 ? null : text.substring(open + 1, close);
    }

    private static String readFile(File file) throws IOException {
        byte[] buffer = new byte[(int) file.length()];
        try (FileInputStream in = new FileInputStream(file)) {
            int read = 0;
            while (read < buffer.length) {
                int got = in.read(buffer, read, buffer.length - read);
                if (got <= 0) break;
                read += got;
            }
        }
        return new String(buffer, "UTF-8");
    }

    private void offerUpdate(Updater.Outcome outcome) {
        if (outcome == null) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    UPDATE_CHANNEL, "App update", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("A newer version of Peach Assist is ready to install");
            nm.createNotificationChannel(channel);
            builder = new Notification.Builder(this, UPDATE_CHANNEL);
        } else {
            builder = new Notification.Builder(this);
        }
        builder.setContentTitle(outcome.newer ? "Update ready to install" : "No newer version")
                .setContentText(outcome.message)
                .setStyle(new Notification.BigTextStyle().bigText(outcome.message))
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setAutoCancel(true);
        if (outcome.install != null) {
            builder.setContentIntent(PendingIntent.getActivity(this, 42, outcome.install,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }
        nm.notify(UPDATE_NOTICE, builder.build());
    }

    /**
     * Rings the handset for a call that arrives while the app is closed.
     *
     * The page cannot do this itself: Android suspends a background WebView, so
     * the invite was arriving, being written down as a missed call, and never
     * making a sound. The server tells the loopback address which call is
     * ringing, and this turns that into a real incoming-call notification. While
     * the app is on screen it stays quiet, because the page rings by itself.
     */



    private void startHoursWatch() {
        if (hoursHandler == null) hoursHandler = new Handler(Looper.getMainLooper());
        hoursHandler.removeCallbacks(hoursCheck);
        hoursHandler.post(hoursCheck);
    }

    private void checkWorkHours() {
        boolean open = true;
        try {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                    new java.net.URL("http://127.0.0.1:" + PORT + "/api/app-state").openConnection();
            c.setConnectTimeout(3000);
            c.setReadTimeout(3000);
            java.io.InputStream in = c.getInputStream();
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[1024];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            in.close();
            c.disconnect();
            // Only an explicit "open":true lets go of the lock; any doubt stays awake.
            open = buf.toString("UTF-8").contains("\"open\":true");
        } catch (Exception e) {
            open = true;
        }
        final boolean isOpen = open;
        if (hoursHandler != null) hoursHandler.post(() -> applyWorkHours(isOpen));
    }

    private void applyWorkHours(boolean open) {
        if (open) {
            holdLocks();
            return;
        }
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        Log.i("peach", "outside work hours: released wake locks so the phone can sleep");
    }

    private void holdLocks() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "peach:server");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) wakeLock.acquire();

        if (multicastLock == null) {
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                multicastLock = wifi.createMulticastLock("peach:ssdp");
                multicastLock.setReferenceCounted(false);
            }
        }
        if (multicastLock != null && !multicastLock.isHeld()) multicastLock.acquire();
    }

    private void runNode() {
        File files = getFilesDir();
        File project = new File(files, "nodejs-project");

        if (wasUpdated()) {
            deleteTree(project);
            copyAssetFolder(getAssets(), "nodejs-project", project.getAbsolutePath());
            saveUpdateStamp();
        }

        // Node exits with 42 when the admin panel asks for a restart, and with
        // anything else when it wants to stay stopped. Loop so a restart needs
        // nobody to touch the phone, and re-copy the assets if the app updated.
        while (true) {
            Integer code = startNodeWithArguments(new String[]{
                    "node",
                    new File(project, "main.js").getAbsolutePath(),
                    files.getAbsolutePath()
            });
            if (code == null || code != 42) break;
            Log.i("PEACH", "server asked to restart");
            if (wasUpdated()) {
                deleteTree(project);
                copyAssetFolder(getAssets(), "nodejs-project", project.getAbsolutePath());
                saveUpdateStamp();
            }
        }
        started.set(false);
    }

    private boolean wasUpdated() {
        if (!new File(getFilesDir(), "nodejs-project/main.js").exists()) return true;
        SharedPreferences prefs = getSharedPreferences("peach", Context.MODE_PRIVATE);
        return prefs.getLong("apk_stamp", 0) != apkStamp();
    }

    private void saveUpdateStamp() {
        getSharedPreferences("peach", Context.MODE_PRIVATE)
                .edit().putLong("apk_stamp", apkStamp()).apply();
    }

    private long apkStamp() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.lastUpdateTime;
        } catch (Exception e) {
            return 1;
        }
    }

    @Override
    public void onDestroy() {
        if (hoursHandler != null) hoursHandler.removeCallbacks(hoursCheck);
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /* ---------- assets ---------- */

    private static boolean deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                if (child.isDirectory()) deleteTree(child);
                else child.delete();
            }
        }
        return file.delete();
    }

    private static boolean copyAssetFolder(AssetManager assets, String from, String to) {
        try {
            String[] files = assets.list(from);
            if (files.length == 0) return copyAssetFile(assets, from, to);
            new File(to).mkdirs();
            boolean ok = true;
            for (String name : files) {
                ok &= copyAssetFolder(assets, from + "/" + name, to + "/" + name);
            }
            return ok;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean copyAssetFile(AssetManager assets, String from, String to) {
        try (InputStream in = assets.open(from)) {
            new File(to).createNewFile();
            try (OutputStream out = new FileOutputStream(to)) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
                out.flush();
            }
            return true;
        } catch (IOException e) {
            return false;
        }
    }
}
