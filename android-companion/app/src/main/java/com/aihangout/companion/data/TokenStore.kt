package com.aihangout.companion.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Local-only, encrypted storage for the human JWT and the enrolled
 * deviceId, per the redaction-pipeline design's recommendation
 * (androidx.security.crypto EncryptedFile/EncryptedSharedPreferences,
 * never plain SharedPreferences, for anything sensitive) -- applied here
 * to session credentials, the same principle as diagnostic result data.
 */
class TokenStore(context: Context) {
    private val prefs = run {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "aihangout_companion_secure",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    var jwt: String?
        get() = prefs.getString("jwt", null)
        set(value) = prefs.edit().putString("jwt", value).apply()

    var deviceId: String?
        get() = prefs.getString("device_id", null)
        set(value) = prefs.edit().putString("device_id", value).apply()

    fun clear() = prefs.edit().clear().apply()
}
