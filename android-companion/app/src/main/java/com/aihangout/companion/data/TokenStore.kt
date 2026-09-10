package com.aihangout.companion.data

import android.content.Context
import android.content.SharedPreferences
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
        set(value) { check(prefs.edit().putString("device_id", value).commit()) { "Failed to persist enrolled device identity" } }

    var lastResult: String?
        get() = prefs.getString("last_result", null)
        set(value) { check(prefs.edit().putString("last_result", value).commit()) { "Failed to persist verified result" } }

    /** Before/after preference + fresh read of the last approved repair -- its own
     * field so the generic result summary can never overwrite it (contract:
     * "record actual before/after ... persist proof/result"). */
    var repairProof: String?
        get() = prefs.getString("repair_proof", null)
        set(value) { check(prefs.edit().putString("repair_proof", value).commit()) { "Failed to persist repair proof" } }

    /** Write-ahead phase storage for [ActionJournal] (the in-flight action
     * and the enrollment-unknown lock), backed by the same encrypted prefs
     * but with `commit()` so each write's success is known synchronously.
     * Replaces the former `pendingActionJson` blob, which was written with
     * `apply()` and only AFTER the create POST -- rejected by A2 as not
     * durable. */
    val phaseStore: PhaseStore = SharedPreferencesPhaseStore(prefs)

    fun clear() = prefs.edit().clear().apply()
}

/** [PhaseStore] over [SharedPreferences] using `commit()` (synchronous,
 * returns whether the write reached disk) -- never `apply()`. */
class SharedPreferencesPhaseStore(private val prefs: SharedPreferences) : PhaseStore {
    override fun put(key: String, value: String): Boolean = prefs.edit().putString(key, value).commit()
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun remove(key: String): Boolean = prefs.edit().remove(key).commit()
}
