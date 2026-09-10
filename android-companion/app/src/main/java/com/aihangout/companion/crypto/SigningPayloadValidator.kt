package com.aihangout.companion.crypto

import org.json.JSONObject

/**
 * Per Team/tasks/A1-to-A3-enrollment-contract-20260908.md: "Never sign
 * arbitrary server commands: validate JSON domain, locally selected
 * claims, challengeId, nonce and expiry before signing the enrollment-
 * only transcript."
 *
 * The device key's signature is proof of intent -- if the app signed
 * whatever string the server returned without checking it, a compromised
 * server or a MITM (bypassing TLS somehow, or a malicious/rogue backend
 * during testing) could get the device to sign a transcript for
 * DIFFERENT claims than the ones the human/app actually submitted (a
 * different agentName, a different publicKeySpki entirely -- attesting
 * to a key the app never generated). This validator makes that
 * impossible: the app never signs a payload whose claims don't match
 * exactly what it locally submitted and holds.
 *
 * Real backend implementation reference (src/mobile-enrollment.js):
 * signingPayload = JSON.stringify({ domain: 'aihangout.mobile.enrollment.v1',
 * challengeId, nonce, ownerUserId, agentName, publicKeySpki, packageName,
 * signingCertSha256, expiresAt }).
 */
object SigningPayloadValidator {
    const val EXPECTED_DOMAIN = "aihangout.mobile.enrollment.v1"

    class ValidationException(message: String) : Exception(message)

    data class ExpectedClaims(
        val challengeId: String,
        val nonce: String,
        val ownerUserId: String,
        val agentName: String,
        val publicKeySpki: String,
        val packageName: String,
        val signingCertSha256: String
    )

    /** Throws if signingPayload does not exactly match what this device
     * locally submitted/received. Returns nothing on success -- callers
     * proceed to sign only after this returns without throwing. */
    fun validate(signingPayload: String, expected: ExpectedClaims) {
        val parsed = try {
            JSONObject(signingPayload)
        } catch (e: Exception) {
            throw ValidationException("signingPayload is not valid JSON: ${e.message}")
        }

        fun requireField(name: String, expectedValue: String) {
            // Explicit has()-then-get() rather than optString(name, null) --
            // org.json's Java signature makes that null-fallback path an
            // ambiguous platform type from Kotlin's perspective (compiler
            // warns the null-check is unreachable, which is misleading
            // rather than reassuring). This is unambiguous either way.
            if (!parsed.has(name) || parsed.isNull(name)) {
                throw ValidationException("signingPayload.$name is missing -- refusing to sign")
            }
            val actual = parsed.getString(name)
            if (actual != expectedValue) {
                throw ValidationException("signingPayload.$name does not match what this device submitted/received -- refusing to sign")
            }
        }

        requireField("domain", EXPECTED_DOMAIN)
        requireField("challengeId", expected.challengeId)
        requireField("nonce", expected.nonce)
        // The backend binds ownerUserId = String(user.id) of whoever's JWT
        // requested the challenge (src/mobile-enrollment.js). Without this
        // check the device would sign a transcript for a DIFFERENT
        // account's enrollment without any local objection.
        requireField("ownerUserId", expected.ownerUserId)
        requireField("agentName", expected.agentName)
        requireField("publicKeySpki", expected.publicKeySpki)
        requireField("packageName", expected.packageName)
        requireField("signingCertSha256", expected.signingCertSha256)

        val expiresAt = parsed.optLong("expiresAt", -1L)
        if (expiresAt <= 0L) {
            throw ValidationException("signingPayload.expiresAt is missing or invalid")
        }
        if (expiresAt <= System.currentTimeMillis()) {
            throw ValidationException("signingPayload.expiresAt has already passed -- refusing to sign an expired challenge")
        }
    }
}
