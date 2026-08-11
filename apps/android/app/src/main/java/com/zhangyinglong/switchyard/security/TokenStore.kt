package com.zhangyinglong.switchyard.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 设备 token / 服务器地址的 Keystore 加密存储。
 * 密钥不可导出（Android Keystore），明文只存在于内存。
 */
class TokenStore(context: Context) {

    val context: Context = context.applicationContext
    private val prefs = context.getSharedPreferences("switchyard_secure", Context.MODE_PRIVATE)
    private val alias = "switchyard_token_key"

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return generator.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val iv = cipher.iv
        val encrypted = cipher.doFinal(plain.toByteArray(StandardCharsets.UTF_8))
        return Base64.encodeToString(iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(encrypted, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String? {
        return try {
            val parts = stored.split(":", limit = 2)
            if (parts.size != 2) return null
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val encrypted = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(encrypted), StandardCharsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    fun saveToken(token: String) {
        prefs.edit().putString("token", encrypt(token)).apply()
    }

    fun loadToken(): String? = prefs.getString("token", null)?.let { decrypt(it) }

    fun clearToken() {
        prefs.edit().remove("token").apply()
    }

    fun saveBaseUrl(url: String) {
        prefs.edit().putString("baseUrl", encrypt(url)).apply()
    }

    fun loadBaseUrl(): String? = prefs.getString("baseUrl", null)?.let { decrypt(it) }

    fun saveDeviceName(name: String) {
        prefs.edit().putString("deviceName", name).apply()
    }

    fun loadDeviceName(): String? = prefs.getString("deviceName", null)
}
