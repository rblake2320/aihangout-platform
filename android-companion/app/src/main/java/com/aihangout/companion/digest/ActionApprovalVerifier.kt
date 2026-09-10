package com.aihangout.companion.digest

import org.json.JSONObject

/**
 * Verifies a server "approved" readback actually IS the exact action this
 * device proposed, before any effect (reading a sensor, sending anything)
 * executes. Per Team/tasks/A2-to-A3-mobile-client-blockers-20260908.md:
 * the app previously only checked `intent.status == "approved"` and never
 * called the already-existing ActionDigest.compute -- so a readback for
 * the wrong action, a tampered capability/riskTier, or a stale/foreign
 * approval record would have been accepted as "go ahead."
 *
 * Every check here is a hard refusal, never a warning: this function
 * either returns normally (execute) or throws RefusedException (do not
 * execute). There is no partial-trust path.
 */
object ActionApprovalVerifier {

    class RefusedException(message: String) : Exception(message)

    /** Everything this device itself knows about the action it proposed,
     * captured at/just after creation -- never taken from a later
     * server response. */
    data class ExpectedAction(
        val actionId: String,
        val deviceId: String,
        val capability: String,
        val riskTier: String,
        val targetDescription: String,
        val createdDigest: String
    )

    fun verifyApprovedForExecution(expected: ExpectedAction, actionReadback: JSONObject) {
        val intent = actionReadback.optJSONObject("intent")
            ?: throw RefusedException("Action readback has no intent object -- refusing to execute")

        // A2 review finding (2026-09-10): a readback that already carries a result
        // object means this action ALREADY executed. Refuse regardless of status, and
        // before any other check, so both callers (polling path + restart branch)
        // are covered by this shared gate. optJSONObject returns null for an absent
        // key AND for JSON null, so a not-yet-reported result still passes here.
        if (actionReadback.optJSONObject("result") != null) {
            throw RefusedException("A result has already been reported for this action -- it already executed; refusing to execute it again")
        }

        val actualActionId = intent.optString("action_id")
        if (actualActionId != expected.actionId) {
            throw RefusedException("Action readback is for actionId='$actualActionId', expected '${expected.actionId}' -- refusing to execute")
        }

        val status = intent.optString("status")
        if (status != "approved") {
            throw RefusedException("Action status is '$status', not 'approved' -- refusing to execute")
        }

        val deviceId = intent.optString("device_id")
        if (deviceId != expected.deviceId) {
            throw RefusedException("Action readback is bound to a different deviceId -- refusing to execute")
        }
        val capability = intent.optString("capability")
        val riskTier = intent.optString("risk_tier")
        val targetDescription = intent.optString("target_description")
        if (capability != expected.capability || riskTier != expected.riskTier || targetDescription != expected.targetDescription) {
            throw RefusedException("Action readback's capability/riskTier/targetDescription do not match what this device originally proposed -- refusing to execute")
        }

        val serverDigest = intent.optString("action_digest")
        val recomputed = ActionDigest.compute(deviceId, capability, riskTier, targetDescription)
        if (serverDigest != recomputed) {
            throw RefusedException("Server-reported action_digest does not match this device's own recomputation -- refusing to execute")
        }
        if (serverDigest != expected.createdDigest) {
            throw RefusedException("Server-reported action_digest does not match the digest returned when this device originally created the action -- refusing to execute")
        }

        val expiresAtRaw = intent.optString("expires_at")
        val expiresAt = try {
            java.time.Instant.parse(expiresAtRaw)
        } catch (e: Exception) {
            throw RefusedException("Action expires_at ('$expiresAtRaw') is not a parseable timestamp -- refusing to execute")
        }
        if (java.time.Instant.now().isAfter(expiresAt)) {
            throw RefusedException("Action has expired -- refusing to execute")
        }

        val approval = actionReadback.optJSONObject("approval")
            ?: throw RefusedException("No approval record present despite status='approved' -- refusing to execute")
        val approvedDigest = approval.optString("approved_digest")
        if (approvedDigest != serverDigest) {
            throw RefusedException("The recorded human approval's digest does not match the current action digest -- refusing to execute")
        }
    }
}
