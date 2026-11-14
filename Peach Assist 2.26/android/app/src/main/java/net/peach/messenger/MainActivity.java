package net.peach.messenger;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.content.pm.PackageManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

import android.app.AlertDialog;

/**
 * The app is a window onto the server already in this folder: it starts the
 * service and points a WebView at the loopback address.
 *
 * The page is loaded exactly once, after the server answers its health check.
 * Reloading on a timer — which this did at first — cancels any sign-in or save
 * that is in flight, and the user experiences it as "wrong password" and
 * "not saved". Nothing here may navigate the page on its own after that.
 */
public class MainActivity extends Activity {

    private static final String BASE = "http://127.0.0.1:" + ServerService.PORT;

    private WebView web;

    /** True while this screen is on top: the service rings only when it is not. */
    public static volatile boolean visible;

    /** Why the service refused to start, if it did. Shown on screen, not swallowed. */
    private String startError;

    /** A microphone/camera request from the page, waiting on Android's answer. */
    private PermissionRequest pendingMedia;
    private static final int REQUEST_WEB_MEDIA = 2;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1);
        }

        try {
            startForegroundService(new Intent(this, ServerService.class));
        } catch (Throwable t) {
            // Android 12+ refuses a foreground service started at the wrong
            // moment. Silence here looks exactly like "the app does not run".
            startError = "Android would not start the server: " + t;
            Log.e("PEACH", startError, t);
        }

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // The page can ask the app to update itself. It cannot do so alone: only
        // the app can reach Android's installer.
        web.addJavascriptInterface(new Bridge(), "PeachApp");
        // A blank white window is the worst possible answer: it could be a refused
        // connection, a crashed renderer or a bad response, and none of them say so.
        // Every one of those now prints itself on screen.
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && !request.isForMainFrame()) return;
                showPageError("The page could not be loaded",
                        (error == null ? "unknown" : error.getErrorCode() + " " + error.getDescription())
                                + "\n" + (request == null ? "" : request.getUrl()));
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The phone reclaimed the WebView's renderer (common when memory is
                // tight). Left alone this leaves a frozen white rectangle.
                showPageError("The page's engine was shut down by Android",
                        (detail != null && detail.didCrash() ? "it crashed" : "it was reclaimed for memory")
                                + "\nTap reload to bring it back.");
                return true;
            }
        });
        // Page-level errors (a 401, a script exception) never reach the screen, so
        // send them where a PC can read them: adb logcat -s PEACH.
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.i("PEACH", message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
                return true;
            }

            /**
             * A web page cannot grant itself a microphone. Until this is answered
             * the call page's getUserMedia is refused, which looks like "calls do
             * not work" with no error anywhere on screen.
             */
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> grantWebMedia(request));
            }
        });

        // The session lives in a cookie; without this the app looks signed out
        // after every step that needs one.
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        web.loadData("<html><body style='font:16px sans-serif;padding:2em;color:#333'>"
                + "<b>Peach Assist</b><br><br>Starting the server\u2026"
                + "<br><br><small style='color:#777'>Hold your finger on the screen to see the server log.</small></body></html>",
                "text/html", "utf-8");
        // Long-press anywhere for the server's own log: the phone's equivalent of
        // a terminal, with no cable and no developer tools.
        web.setOnLongClickListener(v -> {
            showLog();
            return true;
        });

        setContentView(web);

        waitForServerThenLoad();
    }

    /** Answer the page's microphone/camera request, asking Android first if needed. */
    private void grantWebMedia(PermissionRequest request) {
        List<String> wanted = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                    && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                wanted.add(android.Manifest.permission.RECORD_AUDIO);
            }
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                    && checkSelfPermission(android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                wanted.add(android.Manifest.permission.CAMERA);
            }
        }
        if (wanted.isEmpty()) {
            request.grant(request.getResources());
            return;
        }
        pendingMedia = request;
        requestPermissions(wanted.toArray(new String[0]), REQUEST_WEB_MEDIA);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQUEST_WEB_MEDIA || pendingMedia == null) return;
        boolean allowed = results.length > 0;
        for (int result : results) if (result != PackageManager.PERMISSION_GRANTED) allowed = false;
        if (allowed) pendingMedia.grant(pendingMedia.getResources());
        else pendingMedia.deny();
        pendingMedia = null;
    }

    /** The small surface the admin page is allowed to touch. */
    public class Bridge {

        @JavascriptInterface
        public String version() {
            return Updater.versionName(MainActivity.this);
        }

        @JavascriptInterface
        public void installUpdate(final String address) {
            new Thread(() -> {
                final Updater.Outcome outcome = Updater.prepare(MainActivity.this, address);
                runOnUiThread(() -> {
                    Updater.launch(MainActivity.this, outcome);
                    if (web == null) return;
                    String quoted = outcome.message.replace("\\", "\\\\").replace("\"", "\\\"")
                            .replace("\n", " ").replace("\r", " ");
                    web.evaluateJavascript(
                            "window.peachUpdateResult && window.peachUpdateResult({started:"
                                    + outcome.newer + ",message:\"" + quoted + "\"})", null);
                });
            }, "peach-update-js").start();
        }
    }

    private void waitForServerThenLoad() {
        new Thread(() -> {
            for (int attempt = 0; attempt < 60; attempt++) {
                if (isHealthy()) {
                    runOnUiThread(() -> web.loadUrl(BASE + "/"));
                    return;
                }
                try {
                    Thread.sleep(500);
                } catch (InterruptedException ignored) {
                    return;
                }
            }
            // Nothing came up. Show the log itself instead of a browser error page:
            // a blank or refused screen tells nobody anything.
            runOnUiThread(this::showStartupFailure);
        }, "peach-wait").start();
    }

    /** What went wrong, said on screen instead of leaving a white rectangle. */
    private void showPageError(String title, String detail) {
        String html = "<html><body style='font:15px/1.45 sans-serif;padding:1.4em;color:#222'>"
                + "<h3 style='margin:0 0 .5em'>" + esc(title) + "</h3>"
                + "<pre style='white-space:pre-wrap;background:#f3f3f6;padding:.8em;border-radius:8px;font-size:12px'>"
                + esc(detail) + "</pre>"
                + "<p><a href='" + BASE + "/'>Tap here to try again</a></p>"
                + "<p style='color:#666;font-size:13px'>Hold your finger on this screen for the server log.</p>"
                + "</body></html>";
        web.loadDataWithBaseURL(BASE, html, "text/html", "utf-8", null);
    }

    /** The last few lines the server printed, which is where a crash explains itself. */
    private String readLogTail(int maxLines) {
        File file = new File(getFilesDir(), "nodejs-project/server.log");
        File alt = new File(getFilesDir(), "server.log");
        if (alt.exists()) file = alt;
        if (!file.exists()) {
            return "No log yet. The server writes it the moment it starts, so an empty log means Node never printed anything at all.";
        }
        List<String> lines = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new FileReader(file))) {
            String line;
            while ((line = reader.readLine()) != null) lines.add(line);
        } catch (Exception e) {
            return "Could not read the log: " + e;
        }
        if (lines.isEmpty()) return "The log is empty.";
        int from = Math.max(0, lines.size() - maxLines);
        StringBuilder body = new StringBuilder();
        for (int i = from; i < lines.size(); i++) body.append(lines.get(i)).append('\n');
        return body.toString();
    }

    private static String esc(String text) {
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private void showStartupFailure() {
        String html = "<html><body style='font:15px/1.45 sans-serif;padding:1.4em;color:#222'>"
                + "<h3 style='margin:0 0 .5em'>Peach Assist could not start the server</h3>"
                + (startError != null ? "<p style='color:#a11'><b>" + esc(startError) + "</b></p>" : "")
                + "<p>This is the last thing the server said:</p>"
                + "<pre style='white-space:pre-wrap;background:#f3f3f6;padding:.8em;border-radius:8px;font-size:12px'>"
                + esc(readLogTail(40)) + "</pre>"
                + "<p><a href='" + BASE + "/'>Open the page anyway</a></p>"
                + "<p style='color:#666;font-size:13px'>Hold your finger on this screen for the full log.</p>"
                + "</body></html>";
        web.loadDataWithBaseURL(BASE, html, "text/html", "utf-8", null);
    }

    private void showLog() {
        new AlertDialog.Builder(this)
                .setTitle("Server log")
                .setMessage(readLogTail(120))
                .setPositiveButton("Close", null)
                .show();
    }

    private boolean isHealthy() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(BASE + "/health").openConnection();
            connection.setConnectTimeout(1000);
            connection.setReadTimeout(1000);
            return connection.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        visible = false;
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
