package com.zhangyinglong.switchyard;

import android.annotation.SuppressLint;
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

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    tokenStore = new SecureTokenStore(this);
    configureWebView();
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
        return !isTrusted(request.getUrl());
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

  @Override protected void onDestroy() {
    if (fileChooserCallback != null) {
      fileChooserCallback.onReceiveValue(null);
      fileChooserCallback = null;
    }
    if (webView != null) webView.destroy();
    super.onDestroy();
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
  }
}
