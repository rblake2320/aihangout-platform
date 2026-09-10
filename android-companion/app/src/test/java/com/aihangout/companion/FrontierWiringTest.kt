package com.aihangout.companion

import com.aihangout.companion.data.AssistanceProposalValidator
import com.aihangout.companion.data.AssistanceProposalValidator.Outcome
import com.aihangout.companion.data.AssistanceRecord
import com.aihangout.companion.data.DiagnosticsDisabledException
import com.aihangout.companion.data.DiagnosticsPreference
import com.aihangout.companion.data.PhaseStore
import com.aihangout.companion.data.PhaseWriteException
import com.aihangout.companion.diagnostics.BatteryStatus
import com.aihangout.companion.diagnostics.DeviceReader
import com.aihangout.companion.diagnostics.NetworkStatus
import com.aihangout.companion.diagnostics.RepairExecutor
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class FrontierWiringTest {

    private class MemoryStore : PhaseStore {
        val map = HashMap<String, String>()
        override fun put(key: String, value: String): Boolean { map[key] = value; return true }
        override fun get(key: String): String? = map[key]
        override fun remove(key: String): Boolean { map.remove(key); return true }
    }
    private class FailingStore : PhaseStore {
        override fun put(key: String, value: String) = false
        override fun get(key: String): String? = null
        override fun remove(key: String) = false
    }
    private class FakeReader(var calls: Int = 0) : DeviceReader {
        override fun readBatteryStatus(): BatteryStatus { calls++; return BatteryStatus(77, true) }
        override fun readNetworkStatus() = NetworkStatus("wifi", false)
    }

    // ---- preference truly gates the read ----

    @Test
    fun `diagnostics default to disabled and requireEnabled refuses`() {
        val p = DiagnosticsPreference(MemoryStore())
        assertFalse(p.isEnabled())
        assertThrows(DiagnosticsDisabledException::class.java) { p.requireEnabled() }
        p.setEnabled(true)
        p.requireEnabled()
    }

    @Test
    fun `a preference write that does not persist throws instead of pretending`() {
        assertThrows(PhaseWriteException::class.java) { DiagnosticsPreference(FailingStore()).setEnabled(true) }
    }

    // ---- assistance record: stable requestId, write-ahead ----

    @Test
    fun `requestId is persisted before any network call and reused while pending or answered`() {
        val store = MemoryStore()
        val r = AssistanceRecord(store, "7", "https://h")
        val first = r.beginOrResume("dev-1")
        assertTrue(store.map[AssistanceRecord.KEY]!!.contains(first.requestId))
        assertEquals(first.requestId, r.beginOrResume("dev-1").requestId)
        r.markAnswered("diag", null)
        assertEquals(first.requestId, r.beginOrResume("dev-1").requestId)
    }

    @Test
    fun `a definitive failure supersedes the id and a different owner, host or device never resumes it`() {
        val store = MemoryStore()
        val r = AssistanceRecord(store, "7", "https://h")
        val first = r.beginOrResume("dev-1")
        r.markFailed("HTTP 402")
        val second = r.beginOrResume("dev-1")
        assertNotEquals(first.requestId, second.requestId)
        // A different owner (single shared record key) must mint its own id, never resume `second`.
        val other = AssistanceRecord(store, "8", "https://h").beginOrResume("dev-1")
        assertNotEquals(second.requestId, other.requestId)
        // And a different host or device for the original owner does not resume it either.
        assertNotEquals(other.requestId, AssistanceRecord(store, "8", "https://elsewhere").beginOrResume("dev-1").requestId)
        val forDevice = AssistanceRecord(store, "8", "https://elsewhere")
        val d1 = forDevice.beginOrResume("dev-1")
        assertNotEquals(d1.requestId, forDevice.beginOrResume("dev-2").requestId)
        // Every replaced record was archived, never overwritten: first (failed), other's, elsewhere's, d1.
        val archivedIds = forDevice.history().map { it.getJSONObject("record").getString("requestId") }
        assertTrue(archivedIds.contains(first.requestId))
        assertTrue(archivedIds.contains(second.requestId))
        assertTrue(archivedIds.contains(d1.requestId))
        // first (failed), second (foreign to owner 8), other (foreign to elsewhere), d1 (device changed) = 4
        assertEquals(4, archivedIds.size)
    }

    @Test
    fun `assistance record refuses to persist on a failing store`() {
        assertThrows(PhaseWriteException::class.java) { AssistanceRecord(FailingStore(), "7", "https://h").beginOrResume("dev-1") }
    }

    // ---- proposal validator: exact contract or nothing ----

    private fun response(proposal: JSONObject?, requestId: String = "req-1", diagnosis: String = "Diagnostics are off.") =
        JSONObject().put("success", true).put("requestId", requestId).put("diagnosis", diagnosis)
            .put("provider", "openai").put("model", "m").put("proposal", proposal ?: JSONObject.NULL)

    private fun fixed() = JSONObject().put("operation", "enable_companion_diagnostics")
        .put("capability", "ui_click").put("targetDescription", "Enable AIHangout companion diagnostics")

    @Test
    fun `the exact fixed proposal is accepted`() {
        assertTrue(AssistanceProposalValidator.validate(response(fixed()), "req-1") is Outcome.Accepted)
    }

    @Test
    fun `no proposal or explicit no_action is NoAction, never an execution`() {
        assertTrue(AssistanceProposalValidator.validate(response(null), "req-1") is Outcome.NoAction)
        assertTrue(AssistanceProposalValidator.validate(response(JSONObject().put("operation", "no_action")), "req-1") is Outcome.NoAction)
    }

    @Test
    fun `any deviation is rejected -- operation, capability, target wording, extra fields, wrong requestId`() {
        assertTrue(AssistanceProposalValidator.validate(response(fixed().put("operation", "open_settings")), "req-1") is Outcome.Rejected)
        assertTrue(AssistanceProposalValidator.validate(response(fixed().put("capability", "sms_send")), "req-1") is Outcome.Rejected)
        assertTrue(AssistanceProposalValidator.validate(response(fixed().put("targetDescription", "Enable AIHangout companion diagnostics ")), "req-1") is Outcome.Rejected)
        assertTrue(AssistanceProposalValidator.validate(response(fixed().put("command", "am start")), "req-1") is Outcome.Rejected)
        assertTrue(AssistanceProposalValidator.validate(response(fixed().put("coordinates", "10,20")), "req-1") is Outcome.Rejected)
        assertTrue(AssistanceProposalValidator.validate(response(fixed(), requestId = "req-OTHER"), "req-1") is Outcome.Rejected)
    }

    @Test
    fun `diagnosis is plain text -- control characters stripped, length bounded`() {
        val esc = 0x1B.toChar(); val bell = 0x07.toChar()
        val d = AssistanceProposalValidator.plainText("ok$esc[31m$bell" + "x".repeat(5000))
        assertFalse(d.contains(esc))
        assertFalse(d.contains(bell))
        assertTrue(d.startsWith("ok[31m"))
        assertTrue(d.endsWith("… [truncated]"))
    }

    // ---- executor: only this app's preference, proof includes before/after + fresh read ----

    @Test
    fun `the repair flips only the preference and records before-false after-true plus the battery read`() {
        val store = MemoryStore()
        val pref = DiagnosticsPreference(store)
        val reader = FakeReader()
        val out = RepairExecutor(pref, reader).execute("ui_click", "Enable AIHangout companion diagnostics")
        assertFalse(out.preferenceBefore); assertTrue(out.preferenceAfter)
        assertEquals(1, reader.calls)
        assertEquals(77, out.battery.percent)
        val json = JSONObject(out.toContentJson())
        assertEquals("enable_companion_diagnostics", json.getString("operation"))
        assertEquals(1, store.map.size)
    }

    @Test
    fun `the executor refuses any other capability or target before any side effect`() {
        val store = MemoryStore(); val reader = FakeReader()
        val ex = RepairExecutor(DiagnosticsPreference(store), reader)
        assertThrows(IllegalArgumentException::class.java) { ex.execute("ui_click", "Open system settings") }
        assertThrows(IllegalArgumentException::class.java) { ex.execute("sms_send", "Enable AIHangout companion diagnostics") }
        assertTrue(store.map.isEmpty()); assertEquals(0, reader.calls)
    }

    @Test
    fun `if the preference write fails nothing is read`() {
        val reader = FakeReader()
        assertThrows(PhaseWriteException::class.java) {
            RepairExecutor(DiagnosticsPreference(FailingStore()), reader).execute("ui_click", "Enable AIHangout companion diagnostics")
        }
        assertEquals(0, reader.calls)
    }
}
