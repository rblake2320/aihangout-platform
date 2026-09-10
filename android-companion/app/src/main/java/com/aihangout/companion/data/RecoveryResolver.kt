package com.aihangout.companion.data

import com.aihangout.companion.digest.ActionDigest
import org.json.JSONObject
import java.security.MessageDigest

/**
 * Pure resolution of the two ambiguous-outcome cases the write-ahead journal
 * can leave behind (Team/tasks/A1-to-A3-phone-final-recovery-20260910.md):
 *
 *  - a create POST whose response was lost (journal at CREATE_INTENDED), and
 *  - an enroll POST whose response was lost (enrollment-unknown lock set).
 *
 * Both are resolved by an owner-scoped, identity-bound backend lookup, never
 * by replaying the POST. A lookup miss is authoritative evidence of no
 * commit (UNIQUE(device_id, idempotency_key) / UNIQUE(owner, agent_name)); a
 * hit is adopted ONLY if every field the device itself chose matches what
 * the server holds -- anything else is preserved for an operator, never
 * "close enough".
 */
object RecoveryResolver {

    sealed class CreateResolution {
        /** Authoritative miss: nothing was committed under this key; the journal may be archived and work restarted. */
        object NotCommitted : CreateResolution()
        /** The server holds exactly the action this device intended; adopt its identity and continue from CREATED. */
        data class Adopt(val actionId: String, val riskTier: String, val createdDigest: String, val readback: JSONObject) : CreateResolution()
        /** The server holds something under this key that is NOT what this device intended. Preserve; operator decides. */
        data class IdentityMismatch(val reason: String) : CreateResolution()
    }

    fun resolveCreate(journal: JournalState, lookupOrNull: JSONObject?): CreateResolution {
        if (lookupOrNull == null) return CreateResolution.NotCommitted
        val intent = lookupOrNull.optJSONObject("intent")
            ?: return CreateResolution.IdentityMismatch("lookup response has no intent object")

        val mismatches = mutableListOf<String>()
        if (intent.optString("device_id") != journal.deviceId) mismatches += "device_id"
        if (intent.optString("idempotency_key") != journal.idempotencyKey) mismatches += "idempotency_key"
        if (intent.opt("owner_user_id")?.toString() != journal.ownerUserId) mismatches += "owner_user_id"
        if (intent.optString("capability") != journal.capability) mismatches += "capability"
        if (intent.optString("target_description") != journal.targetDescription) mismatches += "target_description"

        val actionId = intent.optString("action_id")
        val riskTier = intent.optString("risk_tier")
        val serverDigest = intent.optString("action_digest")
        if (actionId.isEmpty() || riskTier.isEmpty() || serverDigest.isEmpty()) mismatches += "missing action_id/risk_tier/action_digest"

        // The digest is recomputed from the device's OWN journaled fields plus
        // the server's risk tier -- the same binding ActionApprovalVerifier
        // enforces before any effect. A server-supplied digest is never
        // trusted on its own.
        if (mismatches.isEmpty()) {
            val recomputed = ActionDigest.compute(journal.deviceId, journal.capability, riskTier, journal.targetDescription)
            if (recomputed != serverDigest) mismatches += "action_digest (recomputed ${recomputed.take(12)}… != server ${serverDigest.take(12)}…)"
        }
        if (mismatches.isNotEmpty()) {
            return CreateResolution.IdentityMismatch("lookup hit does not match the journaled intent: ${mismatches.joinToString(", ")}")
        }
        return CreateResolution.Adopt(actionId, riskTier, serverDigest, lookupOrNull)
    }

    sealed class EnrollmentResolution {
        /** Authoritative miss: no device under this agent name; the lock may be archived and enrollment retried. */
        object NotCommitted : EnrollmentResolution()
        /** The server holds an ACTIVE device under this name with exactly this device's public key: adopt it. */
        data class Adopt(val deviceId: String) : EnrollmentResolution()
        /** A device under this name exists but holds a DIFFERENT key. Never adopt; operator must revoke it or choose a new name. */
        data class KeyConflict(val deviceId: String, val existingKeyFingerprint: String) : EnrollmentResolution()
        /** This device's own key is enrolled under this name but the row is revoked; the name cannot be reused (UNIQUE), so a new name is required. */
        data class Revoked(val deviceId: String) : EnrollmentResolution()
    }

    fun resolveEnrollment(agentName: String, localSpkiBase64: String, lookupOrNull: JSONObject?): EnrollmentResolution {
        if (lookupOrNull == null) return EnrollmentResolution.NotCommitted
        val device = lookupOrNull.optJSONObject("device")
            ?: return EnrollmentResolution.KeyConflict("", "lookup response has no device object")
        val deviceId = device.optString("device_id")
        val serverSpki = device.optString("public_key_spki")
        if (device.optString("agent_name") != agentName || deviceId.isEmpty()) {
            return EnrollmentResolution.KeyConflict(deviceId, "agent_name mismatch or missing device_id")
        }
        if (serverSpki != localSpkiBase64) {
            return EnrollmentResolution.KeyConflict(deviceId, sha256Hex(serverSpki))
        }
        return if (device.optString("status") == "active") EnrollmentResolution.Adopt(deviceId)
        else EnrollmentResolution.Revoked(deviceId)
    }

    private fun sha256Hex(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
