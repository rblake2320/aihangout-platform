package com.aihangout.companion

import com.aihangout.companion.data.LegacyResultMigration
import com.aihangout.companion.data.LegacyResultMigration.Plan
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LegacyResultMigrationTest {
    private val id = "e5d679ed-58f1-4c88-abe0-2e0476caeb66"
    private val legacy = "Action $id: Final state: status=approved resultStatus=executed effectStatus=unconfirmed"
    private fun binding(base: String = "http://127.0.0.1:8789") =
        JSONObject().put("deviceId", "dev-9").put("ownerUserId", "7").put("baseUrl", base)

    @Test
    fun `action id is extracted only from a strictly shaped legacy line`() {
        assertEquals(id, LegacyResultMigration.extractActionId(legacy))
        assertNull(LegacyResultMigration.extractActionId(null))
        assertNull(LegacyResultMigration.extractActionId("Idle."))
        assertNull(LegacyResultMigration.extractActionId("Action not-a-uuid: Final state"))
        assertNull(LegacyResultMigration.extractActionId("Repair proof: diagnostics before=false after=true (action $id, hash reported)"))
        assertNull(LegacyResultMigration.extractActionId("Action ${id.uppercase()}: x"))
    }

    @Test
    fun `migration plans a fetch only with a legacy line, no snapshot, and a binding for THIS backend`() {
        val p = LegacyResultMigration.plan(legacy, false, binding(), "http://127.0.0.1:8789") as Plan.Fetch
        assertEquals(id, p.actionId); assertEquals("7", p.ownerUserId); assertEquals("dev-9", p.deviceId)
        assertTrue(LegacyResultMigration.plan(legacy, true, binding(), "http://127.0.0.1:8789") is Plan.None)
        assertTrue(LegacyResultMigration.plan(legacy, false, null, "http://127.0.0.1:8789") is Plan.None)
        assertTrue(LegacyResultMigration.plan(legacy, false, binding("https://staging"), "http://127.0.0.1:8789") is Plan.None)
        assertTrue(LegacyResultMigration.plan("Idle.", false, binding(), "http://127.0.0.1:8789") is Plan.None)
    }

    @Test
    fun `the readback must match the exact action id AND the bound device before anything is saved`() {
        val p = LegacyResultMigration.plan(legacy, false, binding(), "http://127.0.0.1:8789") as Plan.Fetch
        fun rb(action: String, device: String) = JSONObject().put("intent", JSONObject().put("action_id", action).put("device_id", device))
        assertTrue(LegacyResultMigration.bind(rb(id, "dev-9"), p))
        assertFalse(LegacyResultMigration.bind(rb(id, "dev-OTHER"), p))
        assertFalse(LegacyResultMigration.bind(rb("00000000-0000-4000-8000-000000000000", "dev-9"), p))
        assertFalse(LegacyResultMigration.bind(JSONObject(), p))
    }
}
