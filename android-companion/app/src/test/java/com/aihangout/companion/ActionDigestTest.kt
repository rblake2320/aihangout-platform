package com.aihangout.companion

import com.aihangout.companion.digest.ActionDigest
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Test vectors generated from the REAL backend algorithm (Node.js
 * crypto.createHash('sha256').update(JSON.stringify({...}), 'utf8')) --
 * not hand-derived -- so this proves byte-for-byte parity with the actual
 * server, not just internal self-consistency. Regenerate via
 * `node gen_digest_vectors.cjs` (kept alongside this project's design-
 * review receipts) if the backend formula ever changes.
 */
class ActionDigestTest {

    @Test
    fun `matches real Node JSON stringify plus sha256 for a plain read-only case`() {
        val digest = ActionDigest.compute(
            deviceId = "dev-1234",
            capability = "battery_status_read",
            riskTier = "read_only",
            targetDescription = "Check battery percent"
        )
        assertEquals("24bcecab2f948f0f9a4aa86aa57a8f4f5d515319a4c38f9d9c9e3e8fad5ae698", digest)
    }

    @Test
    fun `matches real Node output for a string with quotes, tab, newline, accented text and an emoji`() {
        // Value independently regenerated and byte-length-checked (64 hex
        // chars) via `node -e` directly against this EXACT Kotlin string
        // literal, after an earlier transcription mismatch between two
        // separate verification runs was caught and corrected here.
        val digest = ActionDigest.compute(
            deviceId = "dev-xyz",
            capability = "sms_send",
            riskTier = "communication_send",
            targetDescription = "Send \"hi\"\tthere\nline2\ttab café 😀"
        )
        assertEquals("836b3b45d907bbac12781a34dc3b65e306a78b44e9895efba164e4a4843c9c24", digest)
    }

    @Test
    fun `matches real Node output for the empty-string edge case`() {
        val digest = ActionDigest.compute("", "", "", "")
        assertEquals("ecfd5e0c1b69a28c67cb9d4cdd06c44bbba9c4cd3c968f14686462fa39c2f22d", digest)
    }

    @Test
    fun `is deterministic and order-sensitive -- different field values never collide trivially`() {
        val a = ActionDigest.compute("d1", "battery_status_read", "read_only", "x")
        val b = ActionDigest.compute("d2", "battery_status_read", "read_only", "x")
        assertEquals(a, ActionDigest.compute("d1", "battery_status_read", "read_only", "x"))
        org.junit.Assert.assertNotEquals(a, b)
    }
}
