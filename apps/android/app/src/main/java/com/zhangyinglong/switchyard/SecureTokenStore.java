package com.zhangyinglong.switchyard;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Stores only the mobile-control device token, encrypted with Android Keystore. */
final class SecureTokenStore {
  private static final String PREFS = "switchyard_secure_mobile";
  private static final String TOKEN = "device_token";
  private static final String BASE_URL = "base_url";
  private static final String KEY_ALIAS = "switchyard_mobile_token_key";
  private final SharedPreferences prefs;

  SecureTokenStore(Context context) {
    prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  String getToken() {
    String encoded = prefs.getString(TOKEN, "");
    if (encoded.isEmpty()) return "";
    try {
      byte[] payload = Base64.decode(encoded, Base64.NO_WRAP);
      ByteBuffer buffer = ByteBuffer.wrap(payload);
      int ivLength = buffer.getInt();
      if (ivLength < 12 || ivLength > 32 || buffer.remaining() <= ivLength) throw new IllegalStateException("invalid encrypted token");
      byte[] iv = new byte[ivLength];
      buffer.get(iv);
      byte[] cipherText = new byte[buffer.remaining()];
      buffer.get(cipherText);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
      return new String(cipher.doFinal(cipherText), StandardCharsets.UTF_8);
    } catch (Exception error) {
      clear();
      return "";
    }
  }

  void saveToken(String token) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key());
    byte[] ciphertext = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
    byte[] iv = cipher.getIV();
    ByteBuffer payload = ByteBuffer.allocate(4 + iv.length + ciphertext.length);
    payload.putInt(iv.length).put(iv).put(ciphertext);
    prefs.edit().putString(TOKEN, Base64.encodeToString(payload.array(), Base64.NO_WRAP)).apply();
  }

  String getBaseUrl() { return prefs.getString(BASE_URL, ""); }
  void saveBaseUrl(String url) { prefs.edit().putString(BASE_URL, url).apply(); }
  void clear() { prefs.edit().remove(TOKEN).remove(BASE_URL).apply(); }

  private SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    SecretKey existing = ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)) == null
      ? null : ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
    if (existing != null) return existing;
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .build());
    return generator.generateKey();
  }
}
