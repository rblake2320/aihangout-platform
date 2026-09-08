package com.aihangout.companion

import com.aihangout.companion.diagnostics.BatteryStatus
import com.aihangout.companion.diagnostics.ResultHasher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ResultHasherTest {

    @Test
    fun `hash is prefixed with the algorithm name and is 64 hex chars`() {
        val hash = ResultHasher.hashStructuredResult(
            capability = "battery_status_read", actionId = "act-1", deviceId = "dev-1",
            redactionPolicy = ResultHasher.REDACTION_POLICY_STRUCTURED_FIELDS_V1,
            contentJson = ResultHasher.batteryStatusJson(BatteryStatus(percent = 87, isCharging = true))
        )
        assertTrue(hash.startsWith("sha256:"))
        assertEquals(64, hash.removePrefix("sha256:").length)
    }

    @Test
    fun `different content produces a different hash`() {
        val h1 = ResultHasher.hashStructuredResult(
            "battery_status_read", "act-1", "dev-1", ResultHasher.REDACTION_POLICY_STRUCTURED_FIELDS_V1,
            ResultHasher.batteryStatusJson(BatteryStatus(87, true))
        )
        val h2 = ResultHasher.hashStructuredResult(
            "battery_status_read", "act-1", "dev-1", ResultHasher.REDACTION_POLICY_STRUCTURED_FIELDS_V1,
            ResultHasher.batteryStatusJson(BatteryStatus(50, false))
        )
        assertNotEquals(h1, h2)
    }

    @Test
    fun `different actionId produces a different hash for the same reading (never collides across occurrences)`() {
        val content = ResultHasher.batteryStatusJson(BatteryStatus(87, true))
        val h1 = ResultHasher.hashStructuredResult("battery_status_read", "act-1", "dev-1", ResultHasher.REDACTION_POLICY_STRUCTURED_FIELDS_V1, content)
        val h2 = ResultHasher.hashStructuredResult("battery_status_read", "act-2", "dev-1", ResultHasher.REDACTION_POLICY_STRUCTURED_FIELDS_V1, content)
        assertNotEquals(h1, h2)
    }

    @Test
    fun `network status JSON never contains an ssid or bssid field (redaction rule)`() {
        val json = ResultHasher.networkStatusJson(
            com.aihangout.companion.diagnostics.NetworkStatus(connectionType = "wifi", isMetered = false)
        )
        assertTrue(!json.contains("ssid", ignoreCase = true))
        assertTrue(!json.contains("bssid", ignoreCase = true))
    }
}
