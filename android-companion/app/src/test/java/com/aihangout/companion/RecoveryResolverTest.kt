package com.aihangout.companion

import com.aihangout.companion.data.JournalState
import com.aihangout.companion.data.Phase
import com.aihangout.companion.data.RecoveryResolver
import com.aihangout.companion.data.RecoveryResolver.CreateResolution
import com.aihangout.companion.data.RecoveryResolver.EnrollmentResolution
import com.aihangout.companion.digest.ActionDigest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RecoveryResolverTest {

    private val journal = JournalState(
        phase = Phase.CREATE_INTENDED, idempotencyKey = "android-idem-1", deviceId = "dev-1",
        capability = "battery_status_read", targetDescription = "Check battery percent and charging state",
        ownerUserId = "7", baseUrl = "https://aihangout.ai"
    )
    private val riskTier = "read_only"
    private val goodDigest = ActionDigest.compute(journal.deviceId, journal.capability, riskTier, journal.targetDescription)

    private fun lookup(overrides: Map<String, Any?> = emptyMap()): JSONObject {
        val intent = JSONObject()
            .put("action_id", overrides["action_id"] ?: "act-1")
            .put("device_id", overrides["device_id"] ?: journal.deviceId)
            .put("owner_user_id", overrides["owner_user_id"] ?: 7)
            .put("capability", overrides["capability"] ?: journal.capability)
            .put("risk_tier", overrides["risk_tier"] ?: riskTier)
            .put("target_description", overrides["target_description"] ?: journal.targetDescription)
            .put("action_digest", overrides["action_digest"] ?: goodDigest)
            .put("idempotency_key", overrides["idempotency_key"] ?: journal.idempotencyKey)
            .put("status", "awaiting_approval")
        return JSONObject().put("success", true).put("intent", intent).put("approval", JSONObject.NULL).put("result", JSONObject.NULL)
    }

    // ---- create ----

    @Test
    fun `a lookup miss is authoritative not-committed`() {
        assertEquals(CreateResolution.NotCommitted, RecoveryResolver.resolveCreate(journal, null))
    }

    @Test
    fun `an exact identity match is adopted with the server action id, tier and digest`() {
        val r = RecoveryResolver.resolveCreate(journal, lookup()) as CreateResolution.Adopt
        assertEquals("act-1", r.actionId)
        assertEquals(riskTier, r.riskTier)
        assertEquals(goodDigest, r.createdDigest)
    }

    @Test
    fun `numeric owner_user_id from the server matches the string the journal holds`() {
        assertTrue(RecoveryResolver.resolveCreate(journal, lookup(mapOf("owner_user_id" to 7))) is CreateResolution.Adopt)
        assertTrue(RecoveryResolver.resolveCreate(journal, lookup(mapOf("owner_user_id" to 8))) is CreateResolution.IdentityMismatch)
    }

    @Test
    fun `a hit for a different device or key is a mismatch, never adopted`() {
        assertTrue(RecoveryResolver.resolveCreate(journal, lookup(mapOf("device_id" to "dev-OTHER"))) is CreateResolution.IdentityMismatch)
        assertTrue(RecoveryResolver.resolveCreate(journal, lookup(mapOf("idempotency_key" to "other-key"))) is CreateResolution.IdentityMismatch)
    }

    @Test
    fun `a hit whose digest does not recompute from the journaled fields is a mismatch even if every plain field matches`() {
        val r = RecoveryResolver.resolveCreate(journal, lookup(mapOf("action_digest" to "deadbeef")))
        assertTrue(r is CreateResolution.IdentityMismatch)
        assertTrue((r as CreateResolution.IdentityMismatch).reason.contains("action_digest"))
    }

    @Test
    fun `a hit whose target description differs is a mismatch -- the plan changed`() {
        assertTrue(RecoveryResolver.resolveCreate(journal, lookup(mapOf("target_description" to "Send an SMS"))) is CreateResolution.IdentityMismatch)
    }

    // ---- enrollment ----

    private fun deviceLookup(spki: String, status: String = "active", agent: String = "agent-1"): JSONObject =
        JSONObject().put("success", true).put("device", JSONObject()
            .put("device_id", "dev-9").put("agent_name", agent).put("status", status).put("public_key_spki", spki))

    @Test
    fun `an enrollment lookup miss is authoritative not-committed`() {
        assertEquals(EnrollmentResolution.NotCommitted, RecoveryResolver.resolveEnrollment("agent-1", "SPKI-LOCAL", null))
    }

    @Test
    fun `an active device holding exactly this key is adopted`() {
        assertEquals(EnrollmentResolution.Adopt("dev-9"), RecoveryResolver.resolveEnrollment("agent-1", "SPKI-LOCAL", deviceLookup("SPKI-LOCAL")))
    }

    @Test
    fun `a device under this name holding a DIFFERENT key is a conflict carrying only a fingerprint of the foreign key`() {
        val r = RecoveryResolver.resolveEnrollment("agent-1", "SPKI-LOCAL", deviceLookup("SPKI-SOMEONE-ELSE")) as EnrollmentResolution.KeyConflict
        assertEquals("dev-9", r.deviceId)
        assertEquals(64, r.existingKeyFingerprint.length)
        assertTrue(!r.existingKeyFingerprint.contains("SPKI"))
    }

    @Test
    fun `this key enrolled but revoked is reported as revoked, not adopted`() {
        assertEquals(EnrollmentResolution.Revoked("dev-9"), RecoveryResolver.resolveEnrollment("agent-1", "SPKI-LOCAL", deviceLookup("SPKI-LOCAL", status = "revoked")))
    }

    @Test
    fun `an agent name mismatch in the lookup body is refused`() {
        assertTrue(RecoveryResolver.resolveEnrollment("agent-1", "SPKI-LOCAL", deviceLookup("SPKI-LOCAL", agent = "agent-2")) is EnrollmentResolution.KeyConflict)
    }
}
