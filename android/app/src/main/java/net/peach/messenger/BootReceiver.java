package net.peach.messenger;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Brings the server back after a reboot, or right after the app updates.
 *
 * Without this the phone is only reachable from the moment someone opens the
 * app, which is not something a server should require. Both broadcasts are
 * allowed to start a foreground service even though the app is in the
 * background, so this is the supported way to do it.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : String.valueOf(intent.getAction());
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            return;
        }
        try {
            Intent start = new Intent(context, ServerService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(start);
            } else {
                context.startService(start);
            }
            Log.i("PEACH", "server started by " + action);
        } catch (Throwable t) {
            // Some phones block this outright; the app still works when opened.
            Log.e("PEACH", "could not start the server after " + action + ": " + t);
        }
    }
}
