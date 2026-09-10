package com.aihangout.companion

import com.aihangout.companion.crypto.SigningPayloadValidator
import com.aihangout.companion.crypto.SigningPayloadValidator.ExpectedClaims
import org.json.JSONObject
import org.junit.Assert.assertThrows
import org.junit.Test

class SigningPayloadValidatorTest {

    private val validClaims = ExpectedClaims(
        challengeId = "chal-1", nonce = "nonce-1", ownerUserId = "1", agentName = "agent-1",
        publicKeySpki = "spki-1", packageName = "com.aihangout.companion", signingCertSha256 = "cert-1"
    )

    private fun validPayload(overrides: Map<String, Any> = emptyMap()): String {
        val obj = JSONObject()
            .put("domain", SigningPayloadValidator.EXPECTED_DOMAIN)
            .put("challengeId", validClaims.challengeId)
            .put("nonce", validClaims.nonce)
            .put("ownerUserId", validClaims.ownerUserId)
            .put("agentName", validClaims.agentName)
            .put("publicKeySpki", validClaims.publicKeySpki)
            .put("packageName", validClaims.packageName)
            .put("signingCertSha256", validClaims.signingCertSha256)
            .put("expiresAt", System.currentTimeMillis() + 60000)
        for ((k, v) in overrides) obj.put(k, v)
        return obj.toString()
    }

    @Test
    fun `a payload matching every locally-held claim exactly passes without throwing`() {
        SigningPayloadValidator.validate(validPayload(), validClaims)
        // No exception = pass.
    }

    @Test
    fun `rejects a wrong domain (this exists to catch a payload built for a different protocol entirely)`() {
        assertThrows(SigningPayloadValidator.ValidationException::class.java) {
            SigningPayloadValidator.validate(validPayload(mapOf("domain" to "some.other.protocol.v1")), validClaims)
        }
    }

    @Test
    fun `rejects a challengeId that does not match what this device requested`() {
        assertThrows(SigningPayloadValidator.ValidationException::class.java) {
            SigningPayloadValidator.validate(validPayload(mapOf("challengeId" to "different-challenge")), validClaims)
        }
    }

    @Test
    fun `rejects a publicKeySpki that does not match this device's own key -- the core never-sign-for-a-different-key case`() {
        assertThrows(SigningPayloadValidator.ValidationException::class.java) {
            SigningPayloadValidator.validate(validPayload(mapOf("publicKeySpki" to "attacker-substituted-key")), validClaims)
        }
    }

    @Test
    fun `rejects an agentName mismatch`() {
        assertThrows(SigningPayloadValidator.ValidationException::class.java) {
            SigningPayloadValidator.validate(validPayload(mapOf("agentName" to "different-agent")), validClaims)
        }
    }

    @Test
    fun `rejects a packageName or signingCertSha256 mismatch`() {
        assertThrows(SigningPayloadValidator.ValidationException::class.java) {
            SigningPayloadValidator.validate(validPayload(mapOf("packageName" to "com.evil.app")), validClaims)
        }
        assertThrows(SigningPayloadValidator.ValidationException::class.java) {
            SigningPayloadValidator.validate(validPayload(mapOf("signingCertSha256" to "wrong-cert")), validClaims)
        }
    }

    @Test
    fun `rejects an already-expired payload`() {
        assertThrows(SigningPayloadValidator.ValidationException::class.java) {
            SigningPayloadValidator.validate(validPayload(mapOf("expiresAt" to (System.currentTimeMillis() - 1000))), validClaims)
        }
    }

    @Test
    fun `rejects a missing expiresAt field`() {
        val obj = JSONObject(validPayload())
        obj.remove("expiresAt")
        assertThrows(SigningPayloadValidator.ValidationException::class.java) {
            SigningPayloadValidator.validate(obj.toString(), validClaims)
        }
    }

    @Test
    fun `rejects malformed JSON outright`() {
        assertThrows(SigningPayloadValidator.ValidationException::class.java) {
            SigningPayloadValidator.validate("not json at all", validClaims)
        }
    }

    @Test
    fun `rejects an ownerUserId mismatch -- refuses to sign an enrollment transcript for a different account`() {
        assertThrows(SigningPayloadValidator.ValidationException::class.java) {
            SigningPayloadValidator.validate(validPayload(mapOf("ownerUserId" to "someone-elses-id")), validClaims)
        }
    }

    @Test
    fun `rejects a nonce mismatch`() {
        assertThrows(SigningPayloadValidator.ValidationException::class.java) {
            SigningPayloadValidator.validate(validPayload(mapOf("nonce" to "different-nonce")), validClaims)
        }
    }
}
