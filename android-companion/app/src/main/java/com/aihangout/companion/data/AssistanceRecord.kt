package com.aihangout.companion.data

import org.json.JSONObject
import java.util.UUID

/**
 * Write-ahead record for one `POST /api/mobile/assistance` request. The
 * requestId is generated ONCE, persisted BEFORE the POST, and reused on any
 * timeout/restart so the backend can dedup; a new id is minted only after a
 * definitive server refusal (FAILED). Diagnosis text is stored as-is and is
 * untrusted: callers render it as plain text only.
 */
data class AssistanceState(
    val requestId: String,
    val deviceId: String,
    val ownerUserId: String,
    val baseUrl: String,
    val status: String,               // PENDING | ANSWERED | FAILED | CONSUMED
    val diagnosis: String? = null,
    val proposalJson: String? = null,
    val failure: String? = null
) {
    fun toJson(): String = JSONObject()
        .put("requestId", requestId).put("deviceId", deviceId).put("ownerUserId", ownerUserId)
        .put("baseUrl", baseUrl).put("status", status)
        .putOpt("diagnosis", diagnosis).putOpt("proposalJson", proposalJson).putOpt("failure", failure)
        .toString()

    companion object {
        fun fromJson(raw: String): AssistanceState {
            val j = JSONObject(raw)
            fun opt(k: String) = if (j.has(k) && !j.isNull(k)) j.getString(k) else null
            return AssistanceState(
                j.getString("requestId"), j.getString("deviceId"), j.getString("ownerUserId"), j.getString("baseUrl"),
                j.getString("status"), opt("diagnosis"), opt("proposalJson"), opt("failure")
            )
        }
    }
}

class AssistanceRecord(private val store: PhaseStore, private val ownerUserId: String, private val baseUrl: String) {
    fun load(): AssistanceState? = store.get(KEY)?.let { AssistanceState.fromJson(it) }

    /** Returns the request to send: the existing PENDING/ANSWERED one for this owner/backend/device
     * (stable id) or a fresh one persisted BEFORE any network call. Any record that is replaced --
     * FAILED, CONSUMED, or belonging to a different owner/backend/device -- is archived to an
     * append-only history first; evidence is never overwritten. */
    fun beginOrResume(deviceId: String): AssistanceState {
        val existing = load()
        if (existing != null) {
            val sameIdentity = existing.ownerUserId == ownerUserId && existing.baseUrl == baseUrl && existing.deviceId == deviceId
            if (sameIdentity && existing.status != "FAILED" && existing.status != "CONSUMED") return existing
            archive(existing, if (sameIdentity) "superseded after ${existing.status}" else "foreign record (owner/backend/device differ) replaced")
        }
        val fresh = AssistanceState("assist-${UUID.randomUUID()}", deviceId, ownerUserId, baseUrl, "PENDING")
        write(fresh)
        return fresh
    }

    fun history(): List<JSONObject> {
        val arr = store.get(HISTORY_KEY)?.let { org.json.JSONArray(it) } ?: return emptyList()
        return (0 until arr.length()).map { arr.getJSONObject(it) }
    }

    private fun archive(s: AssistanceState, reason: String) {
        val arr = store.get(HISTORY_KEY)?.let { org.json.JSONArray(it) } ?: org.json.JSONArray()
        arr.put(JSONObject().put("record", JSONObject(s.toJson())).put("reason", reason).put("archivedAtEpochMs", System.currentTimeMillis()))
        if (!store.put(HISTORY_KEY, arr.toString())) throw PhaseWriteException("Failed to archive prior assistance record; it was left in place.")
    }

    fun markAnswered(diagnosis: String, proposalJson: String?) {
        val s = load() ?: throw IllegalStateException("No assistance record.")
        write(s.copy(status = "ANSWERED", diagnosis = diagnosis, proposalJson = proposalJson, failure = null))
    }

    fun markFailed(reason: String) {
        val s = load() ?: throw IllegalStateException("No assistance record.")
        write(s.copy(status = "FAILED", failure = reason))
    }

    /** The proposal was turned into an action intent; the record is kept as evidence. */
    fun markConsumed() {
        val s = load() ?: throw IllegalStateException("No assistance record.")
        write(s.copy(status = "CONSUMED"))
    }

    private fun write(s: AssistanceState) {
        if (!store.put(KEY, s.toJson())) throw PhaseWriteException("Failed to persist assistance request ${s.requestId}.")
    }

    companion object {
        const val KEY = "assistance_request"
        const val HISTORY_KEY = "assistance_request_history"
    }
}
