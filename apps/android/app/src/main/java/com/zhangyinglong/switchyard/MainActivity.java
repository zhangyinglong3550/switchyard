package com.zhangyinglong.switchyard;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Color;
import android.net.Uri;
import android.os.Environment;
import android.os.Bundle;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.ValueCallback;
import android.webkit.DownloadListener;
import android.webkit.WebViewClient;
import android.webkit.URLUtil;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Button;
import android.view.Gravity;
import android.view.View;
import android.widget.TextView;
import android.widget.Toast;
import android.provider.MediaStore;
import android.content.ContentValues;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import android.os.Build;
import android.os.Message;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

import java.net.URI;

/**
 * Android entrypoint. The WebView only renders the local Switchyard Mobile UI;
 * all network requests remain same-origin to the paired desktop's Tailscale HTTPS host.
 */
public final class MainActivity extends Activity {
  private static final String MOBILE_TOKEN_KEY = "switchyard_mobile_token";
  private static final int FILE_CHOOSER_REQUEST = 4101;
  private WebView webView;
  private SecureTokenStore tokenStore;
  private String trustedOrigin = "";
  private LinearLayout webContainer;
  private LinearLayout pairingRecoveryBar;
  private ValueCallback<Uri[]> fileChooserCallback;
  private static final String APPROVAL_CHANNEL_ID = "approvals";
  private static final String STATUS_CHANNEL_ID = "task_status";
  private static final int REQ_NOTIFICATIONS = 7201;
  private String pendingShareText = "";
  private final Handler approvalHandler = new Handler(Looper.getMainLooper());
  private boolean isForeground = true;
  private boolean approvalLoopRunning = false;
  private int lastApprovalCount = -1;
  private final Runnable approvalPoller = new Runnable() {
    @Override public void run() {
      pollApprovalsOnce();
      approvalHandler.postDelayed(this, 45_000);
    }
  };

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    tokenStore = new SecureTokenStore(this);
    configureWebView();
    createNotificationChannels();
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIFICATIONS);
    }
    handleIntent(getIntent());
  }

  @Override public void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    handleIntent(intent);
  }

  @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
  private void configureWebView() {
    webView = new WebView(this);
    webView.setBackgroundColor(Color.rgb(247, 244, 239));
    webView.getSettings().setJavaScriptEnabled(true);
    webView.getSettings().setDomStorageEnabled(true);
    // The paired desktop serves the mobile UI with cache-control: no-store, so
    // the WebView HTTP cache never holds stale copies; asset freshness is owned
    // by the Service Worker's versioned cache. Clearing the WebView cache on
    // every launch only slowed startup, so the cache mode stays at the default.
    webView.getSettings().setCacheMode(android.webkit.WebSettings.LOAD_DEFAULT);
    webView.getSettings().setAllowFileAccess(false);
    // Attachments selected through Android's Storage Access Framework are
    // content:// URIs. WebView needs content access to turn the selected URI
    // into the File object that the mobile UI reads with FileReader. Arbitrary
    // file:// access remains disabled.
    webView.getSettings().setAllowContentAccess(true);
    webView.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    webView.getSettings().setGeolocationEnabled(false);
    webView.addJavascriptInterface(new NativeStoreBridge(), "SwitchyardNative");
    webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
      Toast.makeText(this, "请使用文件预览里的“保存到下载”按钮", Toast.LENGTH_SHORT).show();
    });
    webView.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onConsoleMessage(ConsoleMessage message) { return true; }

      @Override public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
        // Conversation links are handled by the capture-phase JavaScript
        // listener. Reject any residual target=_blank popup instead of letting
        // WebView create an unmanaged child window.
        return false;
      }

      @Override public boolean onShowFileChooser(
          WebView view,
          ValueCallback<Uri[]> callback,
          FileChooserParams params
      ) {
        if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
        fileChooserCallback = callback;
        try {
          Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
          intent.addCategory(Intent.CATEGORY_OPENABLE);
          intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
          String[] acceptTypes = params == null ? new String[0] : params.getAcceptTypes();
          String[] mimeTypes = supportedMimeTypes(acceptTypes);
          intent.setType(mimeTypes.length == 1 ? mimeTypes[0] : "*/*");
          if (mimeTypes.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
          intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params != null
            && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
          startActivityForResult(Intent.createChooser(intent, "选择图片或文件"), FILE_CHOOSER_REQUEST);
          return true;
        } catch (ActivityNotFoundException error) {
          fileChooserCallback = null;
          Toast.makeText(MainActivity.this, "当前设备没有可用的文件选择器", Toast.LENGTH_LONG).show();
          return false;
        }
      }
    });
    webView.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request == null ? null : request.getUrl();
        if (request != null && !request.isForMainFrame()) return false;
        if (isTrusted(uri)) return false;
        return openExternalUrl(uri == null ? "" : uri.toString());
      }

      @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
        Uri uri = url == null ? null : Uri.parse(url);
        if (isTrusted(uri)) return false;
        return openExternalUrl(url);
      }
      @Override public void onPageFinished(WebView view, String url) {
        if (isTrusted(Uri.parse(url))) {
          injectSecureStorage();
          deliverPendingShare();
        }
      }
    });
    webContainer = new LinearLayout(this);
    webContainer.setOrientation(LinearLayout.VERTICAL);
    pairingRecoveryBar = createPairingRecoveryBar();
    webContainer.addView(pairingRecoveryBar, new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
    webContainer.addView(webView, new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
    updatePairingRecoveryBar();
    setContentView(webContainer);
  }

  private String[] supportedMimeTypes(String[] acceptTypes) {
    java.util.ArrayList<String> types = new java.util.ArrayList<>();
    if (acceptTypes != null) {
      for (String value : acceptTypes) {
        if (value == null) continue;
        String type = value.trim().toLowerCase();
        if (type.equals("image/*") || type.matches("[a-z0-9.+-]+/[a-z0-9.+*-]+")) types.add(type);
      }
    }
    return types.toArray(new String[0]);
  }

  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != FILE_CHOOSER_REQUEST) return;
    ValueCallback<Uri[]> callback = fileChooserCallback;
    fileChooserCallback = null;
    if (callback == null) return;
    if (resultCode != RESULT_OK || data == null) {
      callback.onReceiveValue(null);
      return;
    }
    java.util.ArrayList<Uri> selected = new java.util.ArrayList<>();
    ClipData clipData = data.getClipData();
    if (clipData != null) {
      for (int index = 0; index < clipData.getItemCount(); index += 1) {
        Uri uri = clipData.getItemAt(index).getUri();
        if (uri != null) selected.add(uri);
      }
    } else if (data.getData() != null) {
      selected.add(data.getData());
    }
    for (Uri uri : selected) {
      try {
        getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
      } catch (SecurityException ignored) {
        // Some providers grant a one-time read lease only; FileReader consumes
        // it immediately, which is sufficient for the upload flow.
      }
    }
    callback.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new Uri[0]));
  }

  private LinearLayout createPairingRecoveryBar() {
    LinearLayout bar = new LinearLayout(this);
    bar.setOrientation(LinearLayout.HORIZONTAL);
    bar.setGravity(Gravity.CENTER_VERTICAL);
    bar.setPadding(dp(16), dp(8), dp(8), dp(8));
    bar.setBackgroundColor(Color.rgb(232, 239, 232));
    TextView message = new TextView(this);
    message.setText("尚未完成配对");
    message.setTextColor(Color.rgb(25, 70, 45));
    message.setTextSize(14);
    Button edit = new Button(this);
    edit.setText("修改链接");
    edit.setAllCaps(false);
    edit.setOnClickListener((view) -> beginPairingEdit());
    bar.addView(message, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
    bar.addView(edit, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
    return bar;
  }

  private void updatePairingRecoveryBar() {
    if (pairingRecoveryBar == null) return;
    pairingRecoveryBar.setVisibility(tokenStore != null && tokenStore.getToken().isEmpty() ? View.VISIBLE : View.GONE);
  }

  private void beginPairingEdit() {
    tokenStore.clear();
    trustedOrigin = "";
    webView.stopLoading();
    showPairingEntry();
  }

  private void handleIntent(Intent intent) {
    if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
      CharSequence shared = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
      if (shared != null && shared.length() > 0) pendingShareText = shared.toString().trim();
      String rememberedShare = tokenStore.getBaseUrl();
      if (!rememberedShare.isEmpty()) loadTrusted(rememberedShare);
      else showPairingEntry();
      return;
    }
    String pairingUrl = pairingUrl(intent == null ? null : intent.getData());
    if (pairingUrl != null) {
      loadPairingUrl(pairingUrl);
      return;
    }
    String remembered = tokenStore.getBaseUrl();
    if (!remembered.isEmpty()) loadTrusted(remembered);
    else showPairingEntry();
  }

  private void deliverPendingShare() {
    if (pendingShareText == null || pendingShareText.isEmpty() || webView == null) return;
    String payload = pendingShareText;
    pendingShareText = "";
    String escaped = payload
      .replace("\\", "\\\\")
      .replace("\"", "\\\"")
      .replace("\n", "\\n")
      .replace("\r", "");
    webView.evaluateJavascript(
      "(function(){try{if(window.__switchyardShareIn)window.__switchyardShareIn({text:\"" + escaped + "\"});}catch(e){}})();",
      null
    );
  }

  private String pairingUrl(Uri data) {
    if (data == null) return null;
    if ("switchyard".equalsIgnoreCase(data.getScheme()) && "pair".equalsIgnoreCase(data.getHost())) {
      return data.getQueryParameter("url");
    }
    return data.toString();
  }

  private void showPairingEntry() {
    LinearLayout page = new LinearLayout(this);
    page.setOrientation(LinearLayout.VERTICAL);
    int inset = dp(24);
    page.setPadding(inset, dp(64), inset, inset);
    TextView title = new TextView(this);
    title.setText("连接 Switchyard"); title.setTextSize(28); title.setTextColor(Color.rgb(25, 40, 35));
    TextView help = new TextView(this);
    help.setText("粘贴桌面端生成的 Tailscale HTTPS 配对链接。\n配对凭据仅保存在此设备的 Android Keystore 中。");
    help.setTextSize(16); help.setPadding(0, dp(16), 0, dp(16));
    EditText input = new EditText(this);
    input.setHint("https://你的设备.tailnet.ts.net/?challenge=…");
    input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
    android.widget.Button connect = new android.widget.Button(this);
    connect.setText("安全连接");
    connect.setOnClickListener((view) -> loadPairingUrl(input.getText().toString()));
    page.addView(title); page.addView(help); page.addView(input); page.addView(connect);
    setContentView(page);
  }

  private void loadPairingUrl(String raw) {
    try {
      URI uri = new URI(raw.trim());
      if (uri.getHost() == null || !isTrustedScheme(uri)) throw new IllegalArgumentException();
      String nextOrigin = new URI(uri.getScheme(), null, uri.getHost(), uri.getPort(), null, null, null).toString();
      // A new pairing URL must never inherit a token from a previous or mistyped origin.
      if (!nextOrigin.equals(tokenStore.getBaseUrl())) tokenStore.clear();
      trustedOrigin = nextOrigin;
      tokenStore.saveBaseUrl(trustedOrigin);
      updatePairingRecoveryBar();
      setContentView(webContainer);
      webView.loadUrl(uri.toString());
      startApprovalLoop();
    } catch (Exception error) {
      Toast.makeText(this, "请输入桌面端生成的 HTTPS 配对链接", Toast.LENGTH_LONG).show();
      showPairingEntry();
    }
  }

  /** 生产走 Tailscale HTTPS；明文 http 仅允许回环地址（模拟器 adb reverse 联调）。 */
  private boolean isTrustedScheme(URI uri) {
    String scheme = uri.getScheme();
    if ("https".equalsIgnoreCase(scheme)) return true;
    if (!"http".equalsIgnoreCase(scheme)) return false;
    String host = uri.getHost();
    return "127.0.0.1".equals(host) || "localhost".equals(host);
  }

  private void loadTrusted(String baseUrl) {
    try {
      URI uri = new URI(baseUrl);
      if (uri.getHost() == null || !isTrustedScheme(uri)) throw new IllegalArgumentException();
      trustedOrigin = baseUrl;
      updatePairingRecoveryBar();
      setContentView(webContainer);
      webView.loadUrl(baseUrl + "/");
      startApprovalLoop();
    } catch (Exception ignored) {
      tokenStore.clear();
      updatePairingRecoveryBar();
      showPairingEntry();
    }
  }

  private boolean isTrusted(Uri uri) {
    return trustedOrigin != null && !trustedOrigin.isEmpty()
      && uri != null && trustedOrigin.equals(uri.getScheme() + "://" + uri.getAuthority());
  }

  private void fetchAsset(String assetId, String name, String mimeType, boolean openWhenReady) {
    if (assetId == null || assetId.isEmpty() || trustedOrigin.isEmpty()) return;
    final String safeName = name == null || name.trim().isEmpty() ? "switchyard-file" : name.replaceAll("[\\/:*?\"<>|]", "_");
    final String safeMime = mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType;
    new Thread(() -> {
      try {
        HttpURLConnection connection = (HttpURLConnection) new URL(trustedOrigin + "/mobile/v1/assets/" + Uri.encode(assetId)).openConnection();
        connection.setRequestProperty("Authorization", "Bearer " + tokenStore.getToken());
        connection.setConnectTimeout(15_000); connection.setReadTimeout(60_000);
        if (connection.getResponseCode() < 200 || connection.getResponseCode() >= 300) throw new IllegalStateException("HTTP " + connection.getResponseCode());
        Uri outputUri;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          ContentValues values = new ContentValues();
          values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
          values.put(MediaStore.Downloads.MIME_TYPE, safeMime);
          values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Switchyard");
          values.put(MediaStore.Downloads.IS_PENDING, 1);
          outputUri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
          if (outputUri == null) throw new IllegalStateException("无法创建下载文件");
          try (InputStream input = connection.getInputStream(); OutputStream output = getContentResolver().openOutputStream(outputUri)) { copy(input, output); }
          values.clear(); values.put(MediaStore.Downloads.IS_PENDING, 0); getContentResolver().update(outputUri, values, null, null);
        } else {
          throw new IllegalStateException("需要 Android 10 或更新版本才能安全保存下载文件");
        }
        Uri result = outputUri;
        runOnUiThread(() -> {
          Toast.makeText(this, openWhenReady ? "文件已保存，正在打开" : "已保存到 下载/Switchyard", Toast.LENGTH_LONG).show();
          if (openWhenReady) openSavedAsset(result, safeMime);
        });
      } catch (Exception error) {
        runOnUiThread(() -> Toast.makeText(this, "保存文件失败：" + error.getMessage(), Toast.LENGTH_LONG).show());
      }
    }).start();
  }

  private void copy(InputStream input, OutputStream output) throws Exception {
    if (output == null) throw new IllegalStateException("无法写入下载目录");
    byte[] buffer = new byte[32 * 1024]; int count;
    while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
  }

  private void openSavedAsset(Uri uri, String mimeType) {
    try {
      Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mimeType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      startActivity(Intent.createChooser(intent, "打开文件"));
    } catch (ActivityNotFoundException error) {
      Toast.makeText(this, "没有可打开此文件的应用，文件已保存到 下载/Switchyard", Toast.LENGTH_LONG).show();
    }
  }

  private void injectSecureStorage() {
    String script = "(function(){"
      + "try {"
      + "var nativeStore=window.SwitchyardNative;"
      + "localStorage.removeItem('" + MOBILE_TOKEN_KEY + "');"
      + "}catch(e){}"
      + "})();";
    webView.evaluateJavascript(script, null);
  }

  @Override protected void onResume() {
    super.onResume();
    isForeground = true;
    lastApprovalCount = -1;
    recoverDesktopConnection();
  }

  private void recoverDesktopConnection() {
    if (trustedOrigin == null || trustedOrigin.isEmpty() || webView == null) return;
    final String origin = trustedOrigin;
    new Thread(() -> {
      boolean ok = false;
      try {
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + "/mobile/v1/status").openConnection();
        connection.setConnectTimeout(4_000);
        connection.setReadTimeout(4_000);
        ok = connection.getResponseCode() == 200;
        connection.disconnect();
      } catch (Exception ignored) {}
      final boolean reachable = ok;
      runOnUiThread(() -> {
        if (webView == null) return;
        if (reachable) {
          webView.evaluateJavascript("window.SwitchyardResume&&window.SwitchyardResume()", null);
        } else {
          Toast.makeText(this, "桌面端未连接，正在重新加载", Toast.LENGTH_SHORT).show();
          webView.reload();
        }
      });
    }).start();
  }

  @Override protected void onPause() {
    isForeground = false;
    super.onPause();
  }

  @Override protected void onDestroy() {
    stopApprovalLoop();
    if (fileChooserCallback != null) {
      fileChooserCallback.onReceiveValue(null);
      fileChooserCallback = null;
    }
    if (webView != null) webView.destroy();
    super.onDestroy();
  }

  private void createNotificationChannels() {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager == null) return;
    NotificationChannel approvals = new NotificationChannel(APPROVAL_CHANNEL_ID, "待审批操作", NotificationManager.IMPORTANCE_DEFAULT);
    approvals.setDescription("Agent 等待你授权时提醒");
    manager.createNotificationChannel(approvals);
    NotificationChannel status = new NotificationChannel(STATUS_CHANNEL_ID, "任务状态", NotificationManager.IMPORTANCE_DEFAULT);
    status.setDescription("任务完成、失败等状态提醒");
    manager.createNotificationChannel(status);
  }

  private void showStatusNotification(String title, String body) {
    if (isForeground) return;
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
    Intent launch = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
    PendingIntent content = PendingIntent.getActivity(this, 1, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager == null) return;
    android.app.Notification.Builder builder = Build.VERSION.SDK_INT >= 26
      ? new android.app.Notification.Builder(this, STATUS_CHANNEL_ID)
      : new android.app.Notification.Builder(this);
    builder.setSmallIcon(android.R.drawable.stat_notify_more)
      .setContentTitle(title == null || title.isEmpty() ? "Switchyard" : title)
      .setContentText(body == null ? "" : body)
      .setContentIntent(content)
      .setAutoCancel(true);
    manager.notify((int) (System.currentTimeMillis() & 0x0fffffff), builder.build());
  }

  private void sharePlainText(String title, String text) {
    Intent intent = new Intent(Intent.ACTION_SEND);
    intent.setType("text/plain");
    intent.putExtra(Intent.EXTRA_SUBJECT, title == null ? "Switchyard" : title);
    intent.putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
    startActivity(Intent.createChooser(intent, "分享"));
  }

  private void copyPlainText(String text) {
    ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
    if (clipboard == null) {
      Toast.makeText(this, "无法访问剪贴板", Toast.LENGTH_SHORT).show();
      return;
    }
    clipboard.setPrimaryClip(ClipData.newPlainText("Switchyard", text == null ? "" : text));
  }

  private void startApprovalLoop() {
    if (approvalLoopRunning) return;
    approvalLoopRunning = true;
    approvalHandler.postDelayed(approvalPoller, 20_000);
  }

  private void stopApprovalLoop() {
    approvalLoopRunning = false;
    approvalHandler.removeCallbacks(approvalPoller);
  }

  private void pollApprovalsOnce() {
    if (trustedOrigin.isEmpty() || tokenStore.getToken().isEmpty()) return;
    new Thread(() -> {
      int count = -1;
      try {
        HttpURLConnection connection = (HttpURLConnection) new URL(trustedOrigin + "/mobile/v1/approvals").openConnection();
        connection.setRequestProperty("Authorization", "Bearer " + tokenStore.getToken());
        connection.setConnectTimeout(10_000); connection.setReadTimeout(10_000);
        if (connection.getResponseCode() < 200 || connection.getResponseCode() >= 300) return;
        String body = new String(readAll(connection.getInputStream()), java.nio.charset.StandardCharsets.UTF_8);
        count = countOccurrences(body, "\"id\":");
      } catch (Exception ignored) {
        return;
      }
      final int approvals = count;
      runOnUiThread(() -> maybeNotifyApprovals(approvals));
    }).start();
  }

  private void maybeNotifyApprovals(int count) {
    int previous = lastApprovalCount;
    lastApprovalCount = count;
    if (isForeground || count <= 0) return;
    // Notify on 0→N and on growth; a repeated count is already visible in the shade.
    if (previous >= 0 && count <= previous) return;
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
    Intent launch = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
    PendingIntent content = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager == null) return;
    android.app.Notification.Builder builder = Build.VERSION.SDK_INT >= 26
      ? new android.app.Notification.Builder(this, APPROVAL_CHANNEL_ID)
      : new android.app.Notification.Builder(this);
    builder.setSmallIcon(android.R.drawable.stat_notify_more)
      .setContentTitle("Switchyard 待审批")
      .setContentText(count + " 个操作正在等待你的授权")
      .setContentIntent(content)
      .setAutoCancel(true);
    manager.notify(4101, builder.build());
  }

  private static byte[] readAll(InputStream input) throws Exception {
    java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
    byte[] buffer = new byte[16 * 1024]; int count;
    while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
    return output.toByteArray();
  }

  private static int countOccurrences(String text, String needle) {
    int count = 0; int index = 0;
    while ((index = text.indexOf(needle, index)) >= 0) { count += 1; index += needle.length(); }
    return count;
  }

  private boolean openExternalUrl(String rawUrl) {
    if (rawUrl == null || rawUrl.trim().isEmpty()) return true;
    try {
      if (!URLUtil.isNetworkUrl(rawUrl)) {
        Toast.makeText(this, "仅支持打开 HTTP 或 HTTPS 链接", Toast.LENGTH_SHORT).show();
        return true;
      }
      Uri uri = Uri.parse(rawUrl);
      String scheme = uri.getScheme();
      if (!("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) || uri.getHost() == null || uri.getHost().isEmpty()) {
        Toast.makeText(this, "链接无效", Toast.LENGTH_SHORT).show();
        return true;
      }
      Intent intent = new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE);
      if (intent.resolveActivity(getPackageManager()) == null) {
        Toast.makeText(this, "没有可用的浏览器打开此链接", Toast.LENGTH_LONG).show();
        return true;
      }
      startActivity(Intent.createChooser(intent, "使用浏览器打开链接"));
    } catch (Exception error) {
      Toast.makeText(this, "无法打开链接", Toast.LENGTH_SHORT).show();
    }
    return true;
  }

  @Override public void onBackPressed() {
    if (webView == null) {
      super.onBackPressed();
      return;
    }
    // 优先交给前端：关闭浮层 / 详情返回会话列表；未处理时再走 WebView 历史或退出。
    webView.evaluateJavascript(
      "(function(){try{return window.SwitchyardHandleBack&&window.SwitchyardHandleBack()?'1':'0';}catch(e){return '0';}})()",
      value -> runOnUiThread(() -> {
        if ("\"1\"".equals(value) || "1".equals(value)) return;
        if (webView.canGoBack()) webView.goBack();
        else MainActivity.super.onBackPressed();
      })
    );
  }

  private int dp(int value) { return (int) (value * getResources().getDisplayMetrics().density); }

  /** Narrow, origin-gated bridge: encrypted token only; no filesystem, shell, or provider credentials. */
  private final class NativeStoreBridge {
    @JavascriptInterface public String getToken() { return tokenStore.getToken(); }
    @JavascriptInterface public void saveToken(String token) {
      try {
        if (token == null || token.isEmpty()) tokenStore.clear();
        else tokenStore.saveToken(token);
      } catch (Exception ignored) {}
      runOnUiThread(() -> updatePairingRecoveryBar());
    }
    @JavascriptInterface public void clear() {
      tokenStore.clear();
      runOnUiThread(() -> updatePairingRecoveryBar());
    }
    @JavascriptInterface public void editPairingLink() { runOnUiThread(() -> beginPairingEdit()); }
    @JavascriptInterface public void downloadAsset(String id, String name, String mimeType) { fetchAsset(id, name, mimeType, false); }
    @JavascriptInterface public void openAsset(String id, String name, String mimeType) { fetchAsset(id, name, mimeType, true); }
    // 必须显式限定到外层 Activity：同名方法在内部类里会解析成自身，造成无限
    // 递归 → StackOverflowError → 点链接即闪退。
    @JavascriptInterface public void openExternalUrl(String url) {
      runOnUiThread(() -> MainActivity.this.openExternalUrl(url));
    }
    @JavascriptInterface public void shareText(String title, String text) {
      runOnUiThread(() -> MainActivity.this.sharePlainText(title, text));
    }
    @JavascriptInterface public void copyText(String text) {
      runOnUiThread(() -> MainActivity.this.copyPlainText(text));
    }
    @JavascriptInterface public void showNotification(String title, String body) {
      runOnUiThread(() -> MainActivity.this.showStatusNotification(title, body));
    }
    /** 审批等待等关键时刻的触觉反馈；无震动器的设备静默忽略。 */
    @JavascriptInterface public void vibrate(String pattern) {
      try {
        android.os.Vibrator vibrator = (android.os.Vibrator) getSystemService(VIBRATOR_SERVICE);
        if (vibrator == null || !vibrator.hasVibrator()) return;
        long[] pulses = new long[]{0, 40, 70, 40};
        if (pattern != null && pattern.trim().equalsIgnoreCase("long")) pulses = new long[]{0, 70, 90, 70, 90, 70};
        vibrator.vibrate(android.os.VibrationEffect.createWaveform(pulses, -1));
      } catch (Exception ignored) {}
    }
  }
}
