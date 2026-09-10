package com.aihangout.companion

import com.aihangout.companion.digest.ActionApprovalVerifier
import com.aihangout.companion.digest.ActionApprovalVerifier.ExpectedAction
import com.aihangout.companion.digest.ActionDigest
import org.json.JSONObject
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class ActionApprovalVerifierTest {

    private val deviceId = "dev-1"
    private val capability = "battery_status_read"
    private val riskTier = "read_only"
    private val targetDescription = "Check battery percent and charging state"
    private val actionId = "act-1"
    private val digest = ActionDigest.compute(deviceId, capability, riskTier, targetDescription)
    private val futureExpiry = Instant.now().plusSeconds(600).toString()

    private val expected = ExpectedAction(
        actionId = actionId, deviceId = deviceId, capability = capability,
        riskTier = riskTier, targetDescription = targetDescription, createdDigest = digest
    )

    /** The server's readback `result` object for an action that has already executed. */
    private val executedResult = JSONObject()
        .put("result_status", "executed")
        .put("result_payload_hash", "sha256:done")
        .put("reported_at", "2026-09-10T10:00:00Z")

    /** [result] is put under the `result` key verbatim when non-null -- pass a JSONObject
     * for an executed action, or JSONObject.NULL to model the server's explicit JSON null. */
    private fun readback(
        overrides: Map<String, Any?> = emptyMap(),
        includeApproval: Boolean = true,
        result: Any? = null
    ): JSONObject {
        val intent = JSONObject()
            .put("action_id", overrides["action_id"] ?: actionId)
            .put("status", overrides["status"] ?: "approved")
            .put("device_id", overrides["device_id"] ?: deviceId)
            .put("capability", overrides["capability"] ?: capability)
            .put("risk_tier", overrides["risk_tier"] ?: riskTier)
            .put("target_description", overrides["target_description"] ?: targetDescription)
            .put("action_digest", overrides["action_digest"] ?: digest)
            .put("expires_at", overrides["expires_at"] ?: futureExpiry)
        val obj = JSONObject().put("intent", intent)
        if (includeApproval) {
            obj.put("approval", JSONObject().put("approved_digest", overrides["approved_digest"] ?: digest))
        }
        if (result != null) {
            obj.put("result", result)
        }
        return obj
    }

    @Test
    fun `an exact matching approved readback passes without throwing`() {
        ActionApprovalVerifier.verifyApprovedForExecution(expected, readback())
    }

    @Test
    fun `refuses a readback for a different actionId`() {
        assertThrows(ActionApprovalVerifier.RefusedException::class.java) {
            ActionApprovalVerifier.verifyApprovedForExecution(expected, readback(mapOf("action_id" to "act-DIFFERENT")))
        }
    }

    @Test
    fun `refuses a status that is not approved`() {
        assertThrows(ActionApprovalVerifier.RefusedException::class.java) {
            ActionApprovalVerifier.verifyApprovedForExecution(expected, readback(mapOf("status" to "awaiting_approval")))
        }
    }

    @Test
    fun `refuses a readback bound to a different device`() {
        assertThrows(ActionApprovalVerifier.RefusedException::class.java) {
            ActionApprovalVerifier.verifyApprovedForExecution(expected, readback(mapOf("device_id" to "dev-ATTACKER")))
        }
    }

    @Test
    fun `refuses a tampered riskTier even when the digest field is missing from the check -- recomputation catches it`() {
        // capability/riskTier/target changed together so the raw fields differ from `expected`,
        // simulating exactly the downgrade attack ActionDigest's own doc comment describes.
        assertThrows(ActionApprovalVerifier.RefusedException::class.java) {
            ActionApprovalVerifier.verifyApprovedForExecution(expected, readback(mapOf("risk_tier" to "communication_send")))
        }
    }

    @Test
    fun `refuses when the server action_digest does not match this device's own recomputation`() {
        assertThrows(ActionApprovalVerifier.RefusedException::class.java) {
            ActionApprovalVerifier.verifyApprovedForExecution(expected, readback(mapOf("action_digest" to "deadbeef")))
        }
    }

    @Test
    fun `refuses when the server digest does not match the digest captured at action-creation time`() {
        val staleDigest = ActionDigest.compute(deviceId, capability, riskTier, "a different original description")
        val staleExpected = expected.copy(createdDigest = staleDigest)
        assertThrows(ActionApprovalVerifier.RefusedException::class.java) {
            ActionApprovalVerifier.verifyApprovedForExecution(staleExpected, readback())
        }
    }

    @Test
    fun `refuses an already-expired action`() {
        val pastExpiry = Instant.now().minusSeconds(60).toString()
        assertThrows(ActionApprovalVerifier.RefusedException::class.java) {
            ActionApprovalVerifier.verifyApprovedForExecution(expected, readback(mapOf("expires_at" to pastExpiry)))
        }
    }

    @Test
    fun `refuses status approved with no approval record at all`() {
        assertThrows(ActionApprovalVerifier.RefusedException::class.java) {
            ActionApprovalVerifier.verifyApprovedForExecution(expected, readback(includeApproval = false))
        }
    }

    @Test
    fun `refuses when the approval record's digest does not match the current action digest`() {
        assertThrows(ActionApprovalVerifier.RefusedException::class.java) {
            ActionApprovalVerifier.verifyApprovedForExecution(expected, readback(mapOf("approved_digest" to "stale-digest-from-a-prior-plan")))
        }
    }

    @Test
    fun `refuses a missing intent object outright`() {
        assertThrows(ActionApprovalVerifier.RefusedException::class.java) {
            ActionApprovalVerifier.verifyApprovedForExecution(expected, JSONObject())
        }
    }

    // --- A2 finding (2026-09-10): a readback carrying a result already executed ---

    @Test
    fun completedReadbackMustNotAuthorizeAnotherRead() {
        // Otherwise fully valid approved readback; only the presence of `result` differs.
        val ex = assertThrows(ActionApprovalVerifier.RefusedException::class.java) {
            ActionApprovalVerifier.verifyApprovedForExecution(expected, readback(result = executedResult))
        }
        assertTrue("wrong refusal reason: ${ex.message}", ex.message!!.contains("A result has already been reported"))
    }

    @Test
    fun unreportedApprovalStillAuthorizesExactlyOnce() {
        // Control for the JSON-null case: the server serialises a not-yet-reported result as
        // `"result": null`, i.e. the key IS present. Verify (not assume) that org.json's
        // optJSONObject treats JSONObject.NULL as "no result" and the verifier lets it through.
        val rb = readback(result = JSONObject.NULL)
        assertTrue("fixture must carry an explicit result key", rb.has("result"))
        assertTrue("fixture's result must be JSON null, not an object", rb.isNull("result"))
        ActionApprovalVerifier.verifyApprovedForExecution(expected, rb) // must not throw
    }

    @Test
    fun resultPresentIsRefusedEvenBeforeOtherChecksWouldPass() {
        // A wrong device_id is refused on its own, so the message is what proves the
        // result check fired first and is unconditional on every other field.
        val ex = assertThrows(ActionApprovalVerifier.RefusedException::class.java) {
            ActionApprovalVerifier.verifyApprovedForExecution(
                expected, readback(mapOf("device_id" to "dev-ATTACKER"), result = executedResult)
            )
        }
        assertTrue("wrong refusal reason: ${ex.message}", ex.message!!.contains("A result has already been reported"))
    }
}
