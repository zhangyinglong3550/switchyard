package com.zhangyinglong.switchyard;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
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
  private static final int REQ_NOTIFICATIONS = 7201;
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
    createApprovalChannel();
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
    // The mobile UI is served by the paired desktop. Never reuse an older
    // WebView HTTP cache after upgrading the Android shell, otherwise a new
    // launcher icon can misleadingly coexist with an old session interface.
    webView.getSettings().setCacheMode(android.webkit.WebSettings.LOAD_NO_CACHE);
    webView.clearCache(true);
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
        if (isTrusted(uri)) return false;
        return openExternalUrl(uri == null ? "" : uri.toString());
      }

      @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
        Uri uri = url == null ? null : Uri.parse(url);
        if (isTrusted(uri)) return false;
        return openExternalUrl(url);
      }
      @Override public void onPageFinished(WebView view, String url) {
        if (isTrusted(Uri.parse(url))) injectSecureStorage();
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
    String pairingUrl = pairingUrl(intent == null ? null : intent.getData());
    if (pairingUrl != null) {
      loadPairingUrl(pairingUrl);
      return;
    }
    String remembered = tokenStore.getBaseUrl();
    if (!remembered.isEmpty()) loadTrusted(remembered);
    else showPairingEntry();
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
      if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) throw new IllegalArgumentException();
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

  private void loadTrusted(String baseUrl) {
    try {
      URI uri = new URI(baseUrl);
      if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) throw new IllegalArgumentException();
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
    // Returning to the app means the user has seen the inbox; reset so a new
    // approval arriving later notifies again.
    lastApprovalCount = -1;
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

  private void createApprovalChannel() {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationChannel channel = new NotificationChannel(APPROVAL_CHANNEL_ID, "待审批操作", NotificationManager.IMPORTANCE_DEFAULT);
    channel.setDescription("Agent 等待你授权时提醒");
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager != null) manager.createNotificationChannel(channel);
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
      Uri uri = Uri.parse(rawUrl);
      String scheme = uri.getScheme();
      if (!("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) return true;
      Intent intent = new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE);
      if (intent.resolveActivity(getPackageManager()) == null) {
        Toast.makeText(this, "没有可用的浏览器打开此链接", Toast.LENGTH_LONG).show();
        return true;
      }
      startActivity(intent);
    } catch (Exception error) {
      Toast.makeText(this, "无法打开链接", Toast.LENGTH_SHORT).show();
    }
    return true;
  }

  @Override public void onBackPressed() {
    if (webView != null && webView.canGoBack()) webView.goBack();
    else super.onBackPressed();
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
    @JavascriptInterface public void openExternalUrl(String url) { runOnUiThread(() -> openExternalUrl(url)); }
  }
}
