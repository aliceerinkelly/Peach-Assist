package net.peach.messenger;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Updates the app in place.
 *
 * The address is just an APK. The version is read out of the downloaded file
 * itself, so there is no separate manifest to keep in step and nothing to trust
 * but the APK. If it is newer, Android's own installer replaces the app; the
 * package name and signing key are unchanged, so every message, account and
 * setting survives. No uninstall, nothing to copy by hand.
 *
 * prepare() does the work and hands back an intent; whoever asked for the update
 * decides how to open it — the page, directly, or the service, through a
 * notification (a background process may not open windows on its own).
 */
public final class Updater {

    private Updater() {}

    public static final class Outcome {
        public final Intent install;
        public final String message;
        public final boolean newer;

        Outcome(Intent install, String message, boolean newer) {
            this.install = install;
            this.message = message;
            this.newer = newer;
        }
    }

    /** Blocking: download and inspect. Call this off the main thread. */
    public static Outcome prepare(Context context, String address) {
        File file = new File(context.getCacheDir(), "update.apk");
        try {
            if (address == null || !address.trim().toLowerCase().startsWith("http")) {
                return new Outcome(null, "Give an http or https address to an APK first.", false);
            }
            long size = download(address.trim(), file);
            if (size < 1024) {
                return new Outcome(null, "That address returned almost nothing — it is probably an error page, not an APK.", false);
            }

            PackageManager pm = context.getPackageManager();
            PackageInfo incoming = pm.getPackageArchiveInfo(file.getAbsolutePath(), 0);
            if (incoming == null) {
                return new Outcome(null, "That file is not an APK.", false);
            }
            if (!context.getPackageName().equals(incoming.packageName)) {
                return new Outcome(null,
                        "That APK belongs to " + incoming.packageName + ", not to this app. Refusing to install it.", false);
            }

            long mine = versionCode(context);
            long theirs = Build.VERSION.SDK_INT >= 28 ? incoming.getLongVersionCode() : incoming.versionCode;
            String theirName = incoming.versionName == null ? String.valueOf(theirs) : incoming.versionName;
            if (theirs <= mine) {
                return new Outcome(null,
                        "Already on " + versionName(context) + " — that file is " + theirName + ", nothing newer.", false);
            }

            Uri apk = publish(context, file, "Peach-Assist-" + theirName + ".apk");
            // The installer reads the published copy, so the download is spent.
            // Leaving it would fill the cache with old builds nobody can name.
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(apk, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            return new Outcome(install,
                    "Downloaded " + theirName + " (you have " + versionName(context)
                            + "). Tap Update in the installer — messages and settings stay.", true);
        } catch (SecurityException e) {
            return new Outcome(null,
                    "Android would not let the installer open. Allow \"Install unknown apps\" for Peach Assist, then try again.", false);
        } catch (Exception e) {
            Log.e("PEACH", "update failed", e);
            return new Outcome(null, "Update failed: " + e, false);
        }
    }

    /** Open the installer from a screen the person is already looking at. */
    public static void launch(Activity activity, Outcome outcome) {
        if (outcome == null || outcome.install == null) return;
        activity.startActivity(outcome.install);
    }

    private static long download(String address, File target) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(60000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("Accept", "application/octet-stream");
        try {
            int code = connection.getResponseCode();
            if (code != 200 && code != 206) throw new Exception("the address answered " + code);
            long total = 0;
            try (InputStream in = connection.getInputStream();
                 OutputStream out = new FileOutputStream(target, false)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) > 0) {
                    out.write(buffer, 0, read);
                    total += read;
                }
            }
            return total;
        } finally {
            connection.disconnect();
        }
    }

    /**
     * Make the file readable by the installer. Downloads exists as a table from
     * Android 10; older releases get a plain file in the public folder.
     */
    private static Uri publish(Context context, File file, String name) throws Exception {
        pruneOldApks(context);
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver resolver = context.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, "application/vnd.android.package-archive");
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new Exception("could not create the download");
            try (InputStream in = new FileInputStream(file);
                 OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) throw new Exception("could not write the download");
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            }
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(uri, values, null, null);
            return uri;
        }
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists()) dir.mkdirs();
        File out = new File(dir, name);
        try (InputStream in = new FileInputStream(file);
             OutputStream to = new FileOutputStream(out, false)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) to.write(buffer, 0, read);
        }
        return Uri.fromFile(out);
    }

    /**
     * Remove APKs from earlier updates, so exactly one update file is ever on the
     * phone. Copies already installed are unaffected: Android keeps its own
     * package, not this file.
     */
    private static void pruneOldApks(Context context) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver resolver = context.getContentResolver();
                try (Cursor cursor = resolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        new String[]{MediaStore.Downloads._ID, MediaStore.Downloads.DISPLAY_NAME},
                        null, null, null)) {
                    if (cursor == null) return;
                    int idColumn = cursor.getColumnIndexOrThrow(MediaStore.Downloads._ID);
                    int nameColumn = cursor.getColumnIndexOrThrow(MediaStore.Downloads.DISPLAY_NAME);
                    while (cursor.moveToNext()) {
                        String shown = cursor.getString(nameColumn);
                        if (shown == null || !shown.startsWith("PeachMessenger-")) continue;
                        Uri item = android.content.ContentUris.withAppendedId(
                                MediaStore.Downloads.EXTERNAL_CONTENT_URI, cursor.getLong(idColumn));
                        resolver.delete(item, null, null);
                    }
                }
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                File[] files = dir.listFiles((d, n) -> n.startsWith("PeachMessenger-") && n.endsWith(".apk"));
                if (files != null) for (File old : files) {
                    //noinspection ResultOfMethodCallIgnored
                    old.delete();
                }
            }
            File cached = new File(context.getCacheDir(), "update.apk");
            //noinspection ResultOfMethodCallIgnored
            cached.delete();
        } catch (Exception e) {
            Log.w("PEACH", "could not tidy old updates: " + e);
        }
    }

    private static long versionCode(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    static String versionName(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return info.versionName == null ? "?" : info.versionName;
        } catch (Exception e) {
            return "?";
        }
    }
}
