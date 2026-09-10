package com.aihangout.companion.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * The enrolled deviceId is meaningful only for the backend (baseUrl) and
 * owner account it was enrolled with. A1's persistent staging backend has a
 * different owner/device database from the loopback one, so an unbound
 * cached deviceId would be silently reused against a backend that never
 * issued it. This binds the id to owner+endpoint, and on a mismatch it
 * ARCHIVES the prior binding (append-only) and requires fresh enrollment --
 * never silent reuse, never evidence deletion.
 *
 * Legacy migration: a deviceId cached before bindings existed (both Motos)
 * is adopted ONCE for the first owner+endpoint it is used with, then bound.
 */
class DeviceBinding(private val store: PhaseStore) {

    sealed class Resolution {
        object None : Resolution()
        data class Bound(val deviceId: String) : Resolution()
        /** Bound to a different owner or backend: caller must archive and re-enroll. */
        data class Transition(val priorDeviceId: String, val priorOwnerUserId: String, val priorBaseUrl: String) : Resolution()
        /** A cached id with no binding at all. NEVER adopted on trust: the caller must
         * read the device back from the authenticated backend and prove it was issued
         * to this device's own key (see [confirmLegacy]); otherwise [archiveLegacy]. */
        data class LegacyUnbound(val legacyDeviceId: String) : Resolution()
    }

    fun current(): JSONObject? = store.get(KEY)?.let { JSONObject(it) }

    fun resolve(ownerUserId: String, baseUrl: String, legacyDeviceId: String?): Resolution {
        val b = current()
        if (b == null) {
            return if (legacyDeviceId == null) Resolution.None else Resolution.LegacyUnbound(legacyDeviceId)
        }
        return if (b.getString("ownerUserId") == ownerUserId && b.getString("baseUrl") == baseUrl) {
            Resolution.Bound(b.getString("deviceId"))
        } else {
            Resolution.Transition(b.getString("deviceId"), b.getString("ownerUserId"), b.getString("baseUrl"))
        }
    }

    fun bind(deviceId: String, ownerUserId: String, baseUrl: String, migratedFromLegacy: Boolean = false) {
        val blob = JSONObject().put("deviceId", deviceId).put("ownerUserId", ownerUserId).put("baseUrl", baseUrl)
            .put("migratedFromLegacy", migratedFromLegacy).put("boundAtEpochMs", System.currentTimeMillis()).toString()
        if (!store.put(KEY, blob)) throw PhaseWriteException("Failed to persist device binding.")
    }

    /** Adopt a legacy id ONLY when the authenticated backend readback (owner-scoped
     * device lookup) returned exactly this id for this device's own key. */
    fun confirmLegacy(legacyDeviceId: String, backendDeviceId: String, ownerUserId: String, baseUrl: String) {
        require(legacyDeviceId == backendDeviceId) { "backend readback ($backendDeviceId) does not match the cached id ($legacyDeviceId)" }
        bind(legacyDeviceId, ownerUserId, baseUrl, migratedFromLegacy = true)
    }

    /** Quarantine an unbound legacy id that the current backend did not confirm: history entry, never a binding. */
    fun archiveLegacy(legacyDeviceId: String, reason: String) {
        appendHistory(JSONObject().put("legacyUnboundDeviceId", legacyDeviceId).put("reason", reason)
            .put("archivedAtEpochMs", System.currentTimeMillis()))
    }

    /** Append the prior binding to history FIRST, then drop the active one. */
    fun archiveForTransition(reason: String) {
        val b = current() ?: throw IllegalStateException("No device binding to archive.")
        appendHistory(JSONObject().put("binding", b).put("reason", reason).put("archivedAtEpochMs", System.currentTimeMillis()))
        if (!store.remove(KEY)) throw PhaseWriteException("Failed to clear prior device binding after archiving it.")
    }

    private fun appendHistory(entry: JSONObject) {
        val arr = store.get(HISTORY_KEY)?.let { JSONArray(it) } ?: JSONArray()
        arr.put(entry)
        if (!store.put(HISTORY_KEY, arr.toString())) throw PhaseWriteException("Failed to archive device identity evidence; nothing was changed.")
    }

    fun history(): List<JSONObject> {
        val arr = store.get(HISTORY_KEY)?.let { JSONArray(it) } ?: return emptyList()
        return (0 until arr.length()).map { arr.getJSONObject(it) }
    }

    companion object {
        const val KEY = "device_binding"
        const val HISTORY_KEY = "device_binding_history"
    }
}
