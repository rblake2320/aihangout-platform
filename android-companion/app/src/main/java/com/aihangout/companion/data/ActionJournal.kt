package com.aihangout.companion.data

import org.json.JSONObject

/**
 * Durable phase storage whose write success is SYNCHRONOUSLY known.
 * `SharedPreferences.Editor.commit()` returns a Boolean; `apply()` does
 * not -- that difference is the whole point of this interface (A2 review,
 * Team/tasks/A2-to-A3-mobile-client-blockers-20260908.md). Any false
 * return is turned into [PhaseWriteException] by [ActionJournal] BEFORE the
 * caller can take the side effect the write was guarding.
 */
interface PhaseStore {
    fun put(key: String, value: String): Boolean
    fun get(key: String): String?
    fun remove(key: String): Boolean
}

class PhaseWriteException(message: String) : Exception(message)

/** Written AHEAD of the side effect each phase guards (see the table in
 * Team/tasks/A3-helper-durable-phases-20260910.md). */
enum class Phase { CREATE_INTENDED, CREATED, EFFECT_INTENDED, OUTPUT_RECORDED, REPORTED }

data class JournalState(
    val phase: Phase,
    val idempotencyKey: String,
    val deviceId: String,
    val capability: String,
    val targetDescription: String,
    val ownerUserId: String,
    val baseUrl: String,
    val actionId: String? = null,
    val riskTier: String? = null,
    val createdDigest: String? = null,
    val outputHash: String? = null
) {
    fun toJson(): String {
        val json = JSONObject()
            .put("phase", phase.name)
            .put("idempotencyKey", idempotencyKey)
            .put("deviceId", deviceId)
            .put("capability", capability)
            .put("targetDescription", targetDescription)
            .put("ownerUserId", ownerUserId)
            .put("baseUrl", baseUrl)
        actionId?.let { json.put("actionId", it) }
        riskTier?.let { json.put("riskTier", it) }
        createdDigest?.let { json.put("createdDigest", it) }
        outputHash?.let { json.put("outputHash", it) }
        return json.toString()
    }

    companion object {
        fun fromJson(raw: String): JournalState {
            val json = JSONObject(raw)
            fun opt(key: String): String? = if (json.has(key) && !json.isNull(key)) json.getString(key) else null
            return JournalState(
                phase = Phase.valueOf(json.getString("phase")),
                idempotencyKey = json.getString("idempotencyKey"),
                deviceId = json.getString("deviceId"),
                capability = json.getString("capability"),
                targetDescription = json.getString("targetDescription"),
                ownerUserId = json.getString("ownerUserId"),
                baseUrl = json.getString("baseUrl"),
                actionId = opt("actionId"),
                riskTier = opt("riskTier"),
                createdDigest = opt("createdDigest"),
                outputHash = opt("outputHash")
            )
        }
    }
}

/** Outcome of reopening a journal after a restart. [savedHash] is only
 * non-null for SUBMIT_SAVED_OUTPUT and is the EXACT hash recorded before
 * the original report attempt -- never a fresh reading. */
data class ReopenDecision(val outcome: Outcome, val reason: String, val savedHash: String? = null) {
    enum class Outcome {
        UNRESOLVED_CREATE, RECONCILE_RESULT_PRESENT, SUBMIT_SAVED_OUTPUT, QUARANTINE_EFFECT_UNKNOWN,
        RESUME_POLL, EXECUTE, TERMINAL_CLEAR, FOREIGN_JOURNAL, QUARANTINE_RESULT_CONFLICT,
        TERMINAL_OUTPUT_BLOCKED
    }
}

/**
 * Write-ahead journal for the single in-flight action plus the
 * enrollment-unknown lock. Every mutating method throws
 * [PhaseWriteException] when the store reports failure, before returning,
 * so no caller can proceed to a side effect whose intent was not durably
 * recorded. Everything is one JSON blob under [JOURNAL_KEY]; the lock is a
 * separate blob under [ENROLLMENT_UNKNOWN_KEY].
 */
class ActionJournal(
    private val store: PhaseStore,
    private val currentOwnerUserId: String,
    private val currentBaseUrl: String
) {
    fun load(): JournalState? = store.get(JOURNAL_KEY)?.let { JournalState.fromJson(it) }

    fun belongsToCurrentSession(state: JournalState): Boolean =
        state.ownerUserId == currentOwnerUserId && state.baseUrl == currentBaseUrl

    /** Persists CREATE_INTENDED. Must be called BEFORE the create POST. */
    fun beginCreate(idempotencyKey: String, deviceId: String, capability: String, targetDescription: String) {
        check(store.get(JOURNAL_KEY) == null) { "An action journal already exists; resolve it before creating new work." }
        write(
            JournalState(
                phase = Phase.CREATE_INTENDED, idempotencyKey = idempotencyKey, deviceId = deviceId,
                capability = capability, targetDescription = targetDescription,
                ownerUserId = currentOwnerUserId, baseUrl = currentBaseUrl
            )
        )
    }

    fun markCreated(actionId: String, riskTier: String, createdDigest: String) {
        val s = requireState(Phase.CREATE_INTENDED)
        write(s.copy(phase = Phase.CREATED, actionId = actionId, riskTier = riskTier, createdDigest = createdDigest))
    }

    /** Must be called BEFORE the effect (the battery reader) runs. */
    fun markEffectIntended() {
        write(requireState(Phase.CREATED).copy(phase = Phase.EFFECT_INTENDED))
    }

    /** Must be called BEFORE the report POST, with the exact hash to be sent. */
    fun recordOutput(hash: String) {
        write(requireState(Phase.EFFECT_INTENDED).copy(phase = Phase.OUTPUT_RECORDED, outputHash = hash))
    }

    /** Only after the report POST returned a confirmed success. */
    fun markReported() {
        write(requireState(Phase.OUTPUT_RECORDED, Phase.REPORTED).copy(phase = Phase.REPORTED))
    }

    fun clear() {
        if (!store.remove(JOURNAL_KEY)) throw PhaseWriteException("Failed to clear the action journal.")
    }

    /**
     * Operator/reconciliation exit for a journal that must not simply be
     * cleared: the full journal plus the stated reason is appended to an
     * append-only history FIRST (a failed append throws and leaves the active
     * journal untouched), and only then is the active journal removed. Evidence
     * is never deleted, only moved.
     */
    fun archive(reason: String) {
        val s = load() ?: throw IllegalStateException("No action journal exists to archive.")
        appendHistory(JOURNAL_HISTORY_KEY, JSONObject()
            .put("journal", JSONObject(s.toJson()))
            .put("reason", reason)
            .put("archivedAtEpochMs", System.currentTimeMillis()))
        clear()
    }

    fun history(): List<JSONObject> = readHistory(JOURNAL_HISTORY_KEY)

    fun enrollmentLock(): JSONObject? = store.get(ENROLLMENT_UNKNOWN_KEY)?.let { JSONObject(it) }

    /** Same discipline as [archive] for the enrollment-unknown lock. */
    fun archiveEnrollmentLock(reason: String) {
        val lock = enrollmentLock() ?: throw IllegalStateException("No enrollment lock exists to archive.")
        appendHistory(ENROLLMENT_HISTORY_KEY, JSONObject()
            .put("lock", lock)
            .put("reason", reason)
            .put("archivedAtEpochMs", System.currentTimeMillis()))
        clearEnrollmentUnknown()
    }

    fun enrollmentHistory(): List<JSONObject> = readHistory(ENROLLMENT_HISTORY_KEY)

    private fun appendHistory(key: String, entry: JSONObject) {
        val arr = store.get(key)?.let { org.json.JSONArray(it) } ?: org.json.JSONArray()
        arr.put(entry)
        if (!store.put(key, arr.toString())) {
            throw PhaseWriteException("Failed to append to $key; evidence was NOT archived and the active record is left in place.")
        }
    }

    private fun readHistory(key: String): List<JSONObject> {
        val arr = store.get(key)?.let { org.json.JSONArray(it) } ?: return emptyList()
        return (0 until arr.length()).map { arr.getJSONObject(it) }
    }

    fun decide(journal: JournalState, serverReadbackOrNull: JSONObject?): ReopenDecision =
        decide(journal, serverReadbackOrNull, currentOwnerUserId, currentBaseUrl)

    // ---- enrollment-unknown lock ----

    fun lockEnrollmentUnknown(agentName: String, ownerUserId: String, baseUrl: String) {
        val blob = JSONObject().put("agentName", agentName).put("ownerUserId", ownerUserId)
            .put("baseUrl", baseUrl).put("lockedAtEpochMs", System.currentTimeMillis()).toString()
        if (!store.put(ENROLLMENT_UNKNOWN_KEY, blob)) throw PhaseWriteException("Failed to persist the enrollment-unknown lock.")
    }

    fun enrollmentUnknown(): Boolean = store.get(ENROLLMENT_UNKNOWN_KEY) != null

    fun clearEnrollmentUnknown() {
        if (!store.remove(ENROLLMENT_UNKNOWN_KEY)) throw PhaseWriteException("Failed to clear the enrollment-unknown lock.")
    }

    // ---- internals ----

    private fun requireState(vararg allowed: Phase): JournalState {
        val s = load() ?: throw IllegalStateException("No action journal exists.")
        check(s.phase in allowed) { "Journal phase ${s.phase} cannot transition from here (allowed: ${allowed.joinToString()})." }
        return s
    }

    private fun write(state: JournalState) {
        if (!store.put(JOURNAL_KEY, state.toJson())) {
            throw PhaseWriteException("Failed to persist journal phase ${state.phase}; refusing to proceed.")
        }
    }

    companion object {
        const val JOURNAL_KEY = "action_journal"
        const val ENROLLMENT_UNKNOWN_KEY = "enrollment_unknown"
        const val JOURNAL_HISTORY_KEY = "action_journal_history"
        const val ENROLLMENT_HISTORY_KEY = "enrollment_lock_history"
        private val TERMINAL_STATUSES = setOf("expired", "denied", "revoked")

        /**
         * Pure reopen decision. Precedence, top first:
         *  1. FOREIGN_JOURNAL       -- owner/baseUrl mismatch; never resume someone else's journal.
         *  2. RECONCILE_RESULT_PRESENT -- server already holds a result (any phase): done, clear.
         *  3. by phase:
         *     CREATE_INTENDED       -> UNRESOLVED_CREATE (no actionId, no lookup by idempotency key exists yet).
         *     EFFECT_INTENDED       -> QUARANTINE_EFFECT_UNKNOWN (effect may have run; never re-read automatically).
         *     OUTPUT_RECORDED/REPORTED -> SUBMIT_SAVED_OUTPUT carrying the SAME saved hash (no re-read).
         *     CREATED               -> approved: EXECUTE; expired/denied/revoked: TERMINAL_CLEAR; else RESUME_POLL.
         * Phase outcomes for effect-bearing phases deliberately win over a
         * terminal server status: a terminal status cannot undo an effect that
         * already ran, so the operator must see it rather than have it cleared.
         */
        fun decide(
            journal: JournalState, serverReadbackOrNull: JSONObject?,
            currentOwnerUserId: String, currentBaseUrl: String
        ): ReopenDecision {
            if (journal.ownerUserId != currentOwnerUserId || journal.baseUrl != currentBaseUrl) {
                return ReopenDecision(
                    ReopenDecision.Outcome.FOREIGN_JOURNAL,
                    "Journal belongs to owner=${journal.ownerUserId} baseUrl=${journal.baseUrl}, not this session."
                )
            }
            if (serverReadbackOrNull?.optJSONObject("result") != null) {
                val intent = serverReadbackOrNull.optJSONObject("intent")
                val result = serverReadbackOrNull.getJSONObject("result")
                val identityMatches = intent != null &&
                    intent.optString("action_id") == journal.actionId &&
                    intent.optString("device_id") == journal.deviceId &&
                    intent.optString("owner_user_id") == journal.ownerUserId
                val outputMatches = journal.outputHash != null &&
                    result.optString("result_status") == "executed" &&
                    result.optString("result_payload_hash") == journal.outputHash
                if (!identityMatches || !outputMatches) {
                    return ReopenDecision(ReopenDecision.Outcome.QUARANTINE_RESULT_CONFLICT,
                        "Server result does not match locally recorded identity and output; preserve evidence for operator reconciliation.")
                }
                return ReopenDecision(ReopenDecision.Outcome.RECONCILE_RESULT_PRESENT, "Server already holds a result for this action.")
            }
            if (journal.phase in setOf(Phase.OUTPUT_RECORDED, Phase.REPORTED) &&
                serverReadbackOrNull?.optJSONObject("intent")?.optString("status") in TERMINAL_STATUSES) {
                return ReopenDecision(ReopenDecision.Outcome.TERMINAL_OUTPUT_BLOCKED,
                    "Server action is terminal; preserve saved output without automatically submitting it again.")
            }
            return when (journal.phase) {
                Phase.CREATE_INTENDED -> ReopenDecision(
                    ReopenDecision.Outcome.UNRESOLVED_CREATE,
                    "Create was intended (idempotencyKey=${journal.idempotencyKey}) but no actionId was ever recorded and the backend has no lookup by idempotency key yet."
                )
                Phase.EFFECT_INTENDED -> ReopenDecision(
                    ReopenDecision.Outcome.QUARANTINE_EFFECT_UNKNOWN,
                    "Effect was intended for actionId=${journal.actionId} but no output was recorded; whether it ran is unknown."
                )
                Phase.OUTPUT_RECORDED, Phase.REPORTED -> ReopenDecision(
                    ReopenDecision.Outcome.SUBMIT_SAVED_OUTPUT,
                    "Output was recorded for actionId=${journal.actionId} but the server holds no result; re-submit the saved hash.",
                    savedHash = checkNotNull(journal.outputHash) { "OUTPUT_RECORDED journal without a saved hash" }
                )
                Phase.CREATED -> {
                    require(serverReadbackOrNull != null) { "A CREATED journal needs a server readback to decide." }
                    val status = serverReadbackOrNull.optJSONObject("intent")?.optString("status") ?: ""
                    when {
                        status == "approved" -> ReopenDecision(ReopenDecision.Outcome.EXECUTE, "Server status approved; no effect intended yet.")
                        status in TERMINAL_STATUSES -> ReopenDecision(ReopenDecision.Outcome.TERMINAL_CLEAR, "Server status $status.")
                        else -> ReopenDecision(ReopenDecision.Outcome.RESUME_POLL, "Server status ${status.ifEmpty { "unknown" }}; keep polling.")
                    }
                }
            }
        }
    }
}
