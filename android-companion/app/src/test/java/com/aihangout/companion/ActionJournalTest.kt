package com.aihangout.companion

import com.aihangout.companion.data.ActionJournal
import com.aihangout.companion.data.Phase
import com.aihangout.companion.data.PhaseStore
import com.aihangout.companion.data.PhaseWriteException
import com.aihangout.companion.data.ReopenDecision.Outcome
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ActionJournalTest {

    /** Real in-memory store -- a HashMap, no mocking library. */
    private class MemoryPhaseStore : PhaseStore {
        val map = HashMap<String, String>()
        override fun put(key: String, value: String): Boolean { map[key] = value; return true }
        override fun get(key: String): String? = map[key]
        override fun remove(key: String): Boolean { map.remove(key); return true }
    }

    /** Store whose writes report failure (commit() == false) while [failing]. */
    private class FailingPhaseStore : PhaseStore {
        val map = HashMap<String, String>()
        var failing = true
        override fun put(key: String, value: String): Boolean { if (failing) return false; map[key] = value; return true }
        override fun get(key: String): String? = map[key]
        override fun remove(key: String): Boolean { if (failing) return false; map.remove(key); return true }
    }

    private val owner = "user-1"
    private val baseUrl = "https://aihangout.ai"

    private fun journal(store: PhaseStore) = ActionJournal(store, owner, baseUrl)

    private fun begin(j: ActionJournal) = j.beginCreate("idem-1", "dev-1", "battery_status_read", "Check battery")

    private fun created(j: ActionJournal): ActionJournal { begin(j); j.markCreated("act-1", "low", "sha256:digest"); return j }

    private fun readback(status: String, result: JSONObject? = null): JSONObject =
        JSONObject().put("intent", JSONObject().put("status", status).put("action_id", "act-1")
            .put("device_id", "dev-1").put("owner_user_id", owner)).also { if (result != null) it.put("result", result) }

    private val someResult = JSONObject().put("result_status", "executed").put("result_payload_hash", "sha256:saved-hash")

    // ---- write-ahead + failing store ----

    @Test
    fun `beginCreate persists the idempotency key before any network step`() {
        val store = MemoryPhaseStore()
        begin(journal(store))
        val raw = store.get("action_journal")
        assertNotNull(raw)
        assertTrue(raw!!.contains("idem-1"))
        val json = JSONObject(raw)
        assertEquals("CREATE_INTENDED", json.getString("phase"))
        assertEquals(owner, json.getString("ownerUserId"))
        assertEquals(baseUrl, json.getString("baseUrl"))
        assertEquals("dev-1", json.getString("deviceId"))
    }

    @Test
    fun `beginCreate against a failing store throws PhaseWriteException and stores nothing`() {
        val store = FailingPhaseStore()
        try {
            begin(journal(store))
            fail("expected PhaseWriteException")
        } catch (e: PhaseWriteException) {
            assertTrue(store.map.isEmpty())
        }
    }

    @Test
    fun `later phase writes also throw on failure and leave the prior phase intact`() {
        val store = FailingPhaseStore().apply { failing = false }
        val j = journal(store)
        begin(j)
        store.failing = true
        try {
            j.markCreated("act-1", "low", "sha256:digest")
            fail("expected PhaseWriteException")
        } catch (e: PhaseWriteException) {
            assertEquals(Phase.CREATE_INTENDED, j.load()!!.phase)
        }
        try { j.clear(); fail("expected PhaseWriteException") } catch (e: PhaseWriteException) { assertNotNull(j.load()) }
    }

    @Test
    fun `beginCreate refuses while an unresolved journal exists`() {
        val j = journal(MemoryPhaseStore())
        begin(j)
        try { begin(j); fail("expected IllegalStateException") } catch (e: IllegalStateException) { }
    }

    @Test
    fun `phases progress in order and clear removes the blob`() {
        val store = MemoryPhaseStore()
        val j = created(journal(store))
        assertEquals(Phase.CREATED, j.load()!!.phase)
        assertEquals("act-1", j.load()!!.actionId)
        j.markEffectIntended()
        assertEquals(Phase.EFFECT_INTENDED, j.load()!!.phase)
        j.recordOutput("sha256:out")
        assertEquals(Phase.OUTPUT_RECORDED, j.load()!!.phase)
        assertEquals("sha256:out", j.load()!!.outputHash)
        j.markReported()
        assertEquals(Phase.REPORTED, j.load()!!.phase)
        j.clear()
        assertNull(j.load())
        assertNull(store.get("action_journal"))
    }

    // ---- decide() outcomes ----

    @Test
    fun `CREATE_INTENDED with no actionId and null readback is UNRESOLVED_CREATE`() {
        val j = journal(MemoryPhaseStore())
        begin(j)
        assertEquals(Outcome.UNRESOLVED_CREATE, j.decide(j.load()!!, null).outcome)
    }

    @Test
    fun `CREATED and awaiting_approval is RESUME_POLL`() {
        val j = created(journal(MemoryPhaseStore()))
        assertEquals(Outcome.RESUME_POLL, j.decide(j.load()!!, readback("awaiting_approval")).outcome)
    }

    @Test
    fun `CREATED and approved with no effect intended is EXECUTE`() {
        val j = created(journal(MemoryPhaseStore()))
        assertEquals(Outcome.EXECUTE, j.decide(j.load()!!, readback("approved")).outcome)
    }

    @Test
    fun `CREATED and expired, denied or revoked is TERMINAL_CLEAR`() {
        val j = created(journal(MemoryPhaseStore()))
        for (status in listOf("expired", "denied", "revoked")) {
            assertEquals(status, Outcome.TERMINAL_CLEAR, j.decide(j.load()!!, readback(status)).outcome)
        }
    }

    @Test
    fun `EFFECT_INTENDED without output and result null is QUARANTINE_EFFECT_UNKNOWN`() {
        val j = created(journal(MemoryPhaseStore()))
        j.markEffectIntended()
        assertEquals(Outcome.QUARANTINE_EFFECT_UNKNOWN, j.decide(j.load()!!, readback("approved")).outcome)
        // A terminal status must not clear an effect whose outcome is unknown.
        assertEquals(Outcome.QUARANTINE_EFFECT_UNKNOWN, j.decide(j.load()!!, readback("expired")).outcome)
    }

    @Test
    fun `OUTPUT_RECORDED with result null is SUBMIT_SAVED_OUTPUT carrying the same saved hash`() {
        val j = created(journal(MemoryPhaseStore()))
        j.markEffectIntended()
        j.recordOutput("sha256:saved-hash")
        val decision = j.decide(j.load()!!, readback("approved"))
        assertEquals(Outcome.SUBMIT_SAVED_OUTPUT, decision.outcome)
        assertEquals("sha256:saved-hash", decision.savedHash)
    }

    @Test
    fun `only matching recorded output permits result reconciliation`() {
        val store = MemoryPhaseStore()
        val j = created(journal(store))
        assertEquals(Outcome.QUARANTINE_RESULT_CONFLICT, j.decide(j.load()!!, readback("approved", someResult)).outcome)
        j.markEffectIntended()
        assertEquals(Outcome.QUARANTINE_RESULT_CONFLICT, j.decide(j.load()!!, readback("approved", someResult)).outcome)
        j.recordOutput("sha256:saved-hash")
        assertEquals(Outcome.RECONCILE_RESULT_PRESENT, j.decide(j.load()!!, readback("approved", someResult)).outcome)
        j.markReported()
        assertEquals(Outcome.RECONCILE_RESULT_PRESENT, j.decide(j.load()!!, readback("approved", someResult)).outcome)
    }

    @Test
    fun `journal written by a different owner is FOREIGN_JOURNAL`() {
        val store = MemoryPhaseStore()
        created(journal(store))
        val otherOwner = ActionJournal(store, "user-2", baseUrl)
        val state = otherOwner.load()!!
        assertFalse(otherOwner.belongsToCurrentSession(state))
        assertEquals(Outcome.FOREIGN_JOURNAL, otherOwner.decide(state, readback("approved", someResult)).outcome)
        val otherBase = ActionJournal(store, owner, "https://staging.example")
        assertEquals(Outcome.FOREIGN_JOURNAL, otherBase.decide(otherBase.load()!!, null).outcome)
    }

    @Test
    fun `decision survives a JSON round trip of the state`() {
        val store = MemoryPhaseStore()
        val j = created(journal(store))
        j.markEffectIntended()
        j.recordOutput("sha256:rt")
        val reloaded = ActionJournal(store, owner, baseUrl).load()!!
        assertEquals("sha256:rt", reloaded.outputHash)
        assertEquals("sha256:digest", reloaded.createdDigest)
        assertEquals("low", reloaded.riskTier)
        assertEquals("sha256:rt", ActionJournal.decide(reloaded, null, owner, baseUrl).savedHash)
    }

    // ---- enrollment-unknown lock ----

    @Test
    fun `enrollment unknown lock round trip`() {
        val store = MemoryPhaseStore()
        val j = journal(store)
        assertFalse(j.enrollmentUnknown())
        j.lockEnrollmentUnknown("android-companion-1", owner, baseUrl)
        assertTrue(j.enrollmentUnknown())
        assertTrue(store.get("enrollment_unknown")!!.contains("android-companion-1"))
        assertTrue(ActionJournal(store, "user-2", baseUrl).enrollmentUnknown())
        j.clearEnrollmentUnknown()
        assertFalse(j.enrollmentUnknown())
        assertNull(store.get("enrollment_unknown"))
    }

    @Test
    fun `enrollment lock against a failing store throws`() {
        val j = journal(FailingPhaseStore())
        try {
            j.lockEnrollmentUnknown("android-companion-1", owner, baseUrl)
            fail("expected PhaseWriteException")
        } catch (e: PhaseWriteException) {
            assertFalse(j.enrollmentUnknown())
        }
    }
}
