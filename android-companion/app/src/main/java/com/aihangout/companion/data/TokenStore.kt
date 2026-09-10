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

    /** Everything needed to resume or reconcile an in-flight action across
     * a process death/restart -- actionId, its idempotencyKey, and the
     * exact locally-known fields ActionApprovalVerifier needs, as one JSON
     * blob. Per Team/tasks/A2-to-A3-mobile-client-blockers-20260908.md:
     * previously only jwt/deviceId persisted, so a restart mid-flow lost
     * all track of a pending action and the next run silently minted a
     * fresh idempotencyKey instead of reconciling the old one. */
    var pendingActionJson: String?
        get() = prefs.getString("pending_action", null)
        set(value) = prefs.edit().putString("pending_action", value).apply()

    fun clear() = prefs.edit().clear().apply()
}
