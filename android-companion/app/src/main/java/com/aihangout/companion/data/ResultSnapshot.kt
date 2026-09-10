package com.aihangout.companion.data

import org.json.JSONObject

/**
 * Persisted display state of the LAST completed action, bound to the identity
 * that produced it. The old `lastResult` string was a snapshot taken at report
 * time and silently went stale when the human later verified the effect on
 * the web or the action expired. This model is refreshed by GET only
 * (StatusRefresh) and always says where its data came from and how fresh it is.
 */
data class ResultSnapshot(
    val actionId: String,
    val deviceId: String,
    val ownerUserId: String,
    val baseUrl: String,
    val status: String,
    val resultStatus: String?,
    val effectStatus: String?,
    val capturedAtEpochMs: Long,
    val source: String,            // "reported" | "refreshed"
    val staleNote: String? = null  // set only when the cached data could NOT be refreshed
) {
    fun toJson(): String = JSONObject()
        .put("actionId", actionId).put("deviceId", deviceId).put("ownerUserId", ownerUserId).put("baseUrl", baseUrl)
        .put("status", status).putOpt("resultStatus", resultStatus).putOpt("effectStatus", effectStatus)
        .put("capturedAtEpochMs", capturedAtEpochMs).put("source", source).putOpt("staleNote", staleNote).toString()

    /** Display line; the marker is explicit so a cached value is never mistaken for a fresh one. */
    fun render(): String {
        val core = "Action $actionId: status=$status resultStatus=${resultStatus ?: "none"} effectStatus=${effectStatus ?: "none"}"
        val marker = when {
            staleNote != null -> " [CACHED, NOT REFRESHED: $staleNote]"
            source == "refreshed" -> " [refreshed from server]"
            else -> " [as reported; not yet refreshed]"
        }
        return core + marker
    }

    companion object {
        fun fromJson(raw: String): ResultSnapshot {
            val j = JSONObject(raw)
            fun opt(k: String) = if (j.has(k) && !j.isNull(k)) j.getString(k) else null
            return ResultSnapshot(
                j.getString("actionId"), j.getString("deviceId"), j.getString("ownerUserId"), j.getString("baseUrl"),
                j.getString("status"), opt("resultStatus"), opt("effectStatus"), j.getLong("capturedAtEpochMs"),
                j.getString("source"), opt("staleNote")
            )
        }

        /** Build from a server readback (`intent`/`result`/`effect`), binding the identity that requested it. */
        fun fromReadback(readback: JSONObject, ownerUserId: String, baseUrl: String, source: String, nowMs: Long): ResultSnapshot {
            val intent = readback.getJSONObject("intent")
            val result = readback.optJSONObject("result")
            val effect = readback.optJSONObject("effect")
            return ResultSnapshot(
                actionId = intent.getString("action_id"), deviceId = intent.optString("device_id"),
                ownerUserId = ownerUserId, baseUrl = baseUrl,
                status = intent.optString("status"),
                resultStatus = result?.optString("result_status")?.takeIf { it.isNotEmpty() },
                effectStatus = effect?.optString("effect_status")?.takeIf { it.isNotEmpty() },
                capturedAtEpochMs = nowMs, source = source
            )
        }
    }
}

/** GET-only refresh policy. Never mutates server state; never resumes a journal. */
object StatusRefresh {
    sealed class Outcome {
        data class Updated(val snapshot: ResultSnapshot, val whatChanged: String) : Outcome()
        data class Unchanged(val snapshot: ResultSnapshot) : Outcome()
        /** Server unreachable: cached evidence preserved and marked. */
        data class OfflinePreserved(val snapshot: ResultSnapshot) : Outcome()
        /** Server no longer returns the action (404): cached evidence preserved and marked. */
        data class ServerUnknownPreserved(val snapshot: ResultSnapshot) : Outcome()
        /** Cached snapshot belongs to another owner/backend: refuse to refresh it against this session. */
        data class ForeignRefused(val snapshot: ResultSnapshot) : Outcome()
    }

    fun merge(cached: ResultSnapshot, readbackOrNull: JSONObject?, offline: Boolean, ownerUserId: String, baseUrl: String, nowMs: Long): Outcome {
        if (cached.ownerUserId != ownerUserId || cached.baseUrl != baseUrl) {
            return Outcome.ForeignRefused(cached.copy(staleNote = "belongs to owner ${cached.ownerUserId} at ${cached.baseUrl}; not refreshed in this session"))
        }
        if (offline) return Outcome.OfflinePreserved(cached.copy(staleNote = "offline since ${cached.capturedAtEpochMs}"))
        if (readbackOrNull == null) return Outcome.ServerUnknownPreserved(cached.copy(staleNote = "server no longer returns action ${cached.actionId}"))
        val fresh = ResultSnapshot.fromReadback(readbackOrNull, ownerUserId, baseUrl, "refreshed", nowMs)
        if (fresh.actionId != cached.actionId) {
            return Outcome.ForeignRefused(cached.copy(staleNote = "readback was for a different action; not applied"))
        }
        val changes = mutableListOf<String>()
        if (fresh.status != cached.status) changes += "status ${cached.status}->${fresh.status}"
        if (fresh.resultStatus != cached.resultStatus) changes += "result ${cached.resultStatus}->${fresh.resultStatus}"
        if (fresh.effectStatus != cached.effectStatus) changes += "effect ${cached.effectStatus}->${fresh.effectStatus}"
        return if (changes.isEmpty()) Outcome.Unchanged(fresh) else Outcome.Updated(fresh, changes.joinToString(", "))
    }
}
