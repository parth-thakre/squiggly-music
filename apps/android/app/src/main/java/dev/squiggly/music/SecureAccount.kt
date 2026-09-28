package dev.squiggly.music

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The saved sign-in (server, username, password as JSON), sealed with AES-GCM under a key that
 * lives in the Android Keystore and can't be read out of it. Only the sealed bytes reach
 * SharedPreferences. When the Keystore fails, nothing is saved and the page keeps the password
 * for the session only, as the desktop does without a keyring.
 */
object SecureAccount {
    private const val KEY_ALIAS = "squiggly-account"
    private const val PREFERENCES = "squiggly-account"
    private const val FIELD = "sealed"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    // Ties the sealed bytes to this purpose and format.
    private val context = "squiggly-account-v1".toByteArray()

    fun available(): Boolean = runCatching { key() }.isSuccess

    fun save(app: Context, json: String): Boolean = runCatching {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(context)
        val sealed = cipher.iv + cipher.doFinal(json.toByteArray(Charsets.UTF_8))
        preferences(app).edit().putString(FIELD, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()
    }.getOrDefault(false)

    /** The saved JSON, or null. Bytes that can't be opened (a reset Keystore) are forgotten. */
    fun load(app: Context): String? {
        val stored = preferences(app).getString(FIELD, null) ?: return null
        return runCatching {
            val sealed = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, 12))
            cipher.updateAAD(context)
            String(cipher.doFinal(sealed, 12, sealed.size - 12), Charsets.UTF_8)
        }.getOrElse { forget(app); null }
    }

    fun forget(app: Context) {
        preferences(app).edit().remove(FIELD).commit()
    }

    private fun preferences(app: Context) = app.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }
}
