package com.aihangout.companion

import com.aihangout.companion.data.ActionJournal
import com.aihangout.companion.data.PhaseStore
import com.aihangout.companion.data.PhaseWriteException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Evidence is moved, never deleted: archive appends to history FIRST and
 * only then clears the active record; a failed append leaves everything. */
class ActionJournalArchiveTest {

    private class MemoryPhaseStore : PhaseStore {
        val map = HashMap<String, String>()
        override fun put(key: String, value: String): Boolean { map[key] = value; return true }
        override fun get(key: String): String? = map[key]
        override fun remove(key: String): Boolean { map.remove(key); return true }
    }

    /** Fails only writes to the history keys -- models a full/failed evidence store. */
    private class HistoryFailingStore : PhaseStore {
        val map = HashMap<String, String>()
        override fun put(key: String, value: String): Boolean {
            if (key == ActionJournal.JOURNAL_HISTORY_KEY || key == ActionJournal.ENROLLMENT_HISTORY_KEY) return false
            map[key] = value; return true
        }
        override fun get(key: String): String? = map[key]
        override fun remove(key: String): Boolean { map.remove(key); return true }
    }

    private fun journal(store: PhaseStore) = ActionJournal(store, "user-1", "https://aihangout.ai")

    @Test
    fun `archive moves the journal into history with its reason and clears the active record`() {
        val store = MemoryPhaseStore()
        val j = journal(store)
        j.beginCreate("idem-1", "dev-1", "battery_status_read", "Check battery")
        j.archive("lookup miss")
        assertNull(j.load())
        val history = j.history()
        assertEquals(1, history.size)
        assertEquals("lookup miss", history[0].getString("reason"))
        assertEquals("idem-1", history[0].getJSONObject("journal").getString("idempotencyKey"))
        assertTrue(history[0].getLong("archivedAtEpochMs") > 0)
    }

    @Test
    fun `history is append-only across repeated archives`() {
        val store = MemoryPhaseStore()
        val j = journal(store)
        j.beginCreate("idem-1", "dev-1", "battery_status_read", "Check battery"); j.archive("first")
        j.beginCreate("idem-2", "dev-1", "battery_status_read", "Check battery"); j.archive("second")
        val reasons = j.history().map { it.getString("reason") }
        assertEquals(listOf("first", "second"), reasons)
    }

    @Test
    fun `a failed history append throws and leaves the active journal in place`() {
        val store = HistoryFailingStore()
        val j = journal(store)
        j.beginCreate("idem-1", "dev-1", "battery_status_read", "Check battery")
        assertThrows(PhaseWriteException::class.java) { j.archive("will fail") }
        assertNotNull("active journal must survive a failed archive", j.load())
        assertTrue(j.history().isEmpty())
    }

    @Test
    fun `the enrollment lock archives the same way and clears only after the append succeeds`() {
        val ok = MemoryPhaseStore()
        val j = journal(ok)
        j.lockEnrollmentUnknown("agent-1", "user-1", "https://aihangout.ai")
        assertNotNull(j.enrollmentLock())
        j.archiveEnrollmentLock("adopted after lookup")
        assertNull(j.enrollmentLock())
        assertEquals("agent-1", j.enrollmentHistory()[0].getJSONObject("lock").getString("agentName"))

        val failing = HistoryFailingStore()
        val k = journal(failing)
        k.lockEnrollmentUnknown("agent-2", "user-1", "https://aihangout.ai")
        assertThrows(PhaseWriteException::class.java) { k.archiveEnrollmentLock("will fail") }
        assertTrue(k.enrollmentUnknown())
    }
}
