package com.aihangout.companion

import com.aihangout.companion.scheduler.BoundedExecution
import com.aihangout.companion.scheduler.JobStatus
import com.aihangout.companion.scheduler.MemoryScheduleStore
import com.aihangout.companion.scheduler.OperationRegistry
import com.aihangout.companion.scheduler.SchedulerAlarms
import com.aihangout.companion.scheduler.SchedulerPolicy
import com.aihangout.companion.scheduler.SchedulerPolicy.FireDecision
import com.aihangout.companion.scheduler.ScheduledJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Changed-case regressions for A5's three scheduler findings (A5-scheduled-sms-bridge-20260911.md §5). */
class SchedulerRepairTest {
    private val now = 1_800_000_000_000L
    private fun pending(store: MemoryScheduleStore, id: String, fireAt: Long) =
        store.insert(ScheduledJob(id, OperationRegistry.BATTERY_STATUS_READ, fireAt, "UTC", JobStatus.PENDING, now - 1000))

    // Finding 1: reconciliation on app start / package replace, not only reboot.
    @Test
    fun `reconcile on app start quarantines a RUNNING orphan and marks overdue PENDING missed, and is idempotent`() {
        val store = MemoryScheduleStore()
        pending(store, "orphan", now - 30_000); pending(store, "overdue", now - 3_600_000); pending(store, "future", now + 3_600_000)
        assertTrue(SchedulerPolicy.onFire(store, "orphan", now - 30_000) is FireDecision.Execute) // receiver killed here
        val first = SchedulerPolicy.reconcile(store, now)
        assertEquals(listOf("orphan"), first.quarantined.map { it.id })
        assertEquals(listOf("overdue"), first.missed.map { it.id })
        assertEquals(listOf("future"), first.reschedule.map { it.id })
        assertEquals(JobStatus.UNKNOWN, store.get("orphan")!!.status)
        // Second start: nothing changes, nothing replays, future still armed for re-arming.
        val second = SchedulerPolicy.reconcile(store, now + 1)
        assertTrue(second.quarantined.isEmpty() && second.missed.isEmpty())
        assertEquals(listOf("future"), second.reschedule.map { it.id })
        assertTrue(SchedulerPolicy.onFire(store, "orphan", now + 2) is FireDecision.Ignore)
    }

    // Finding 2: PendingIntent identity must not depend on hashCode() alone.
    @Test
    fun `two job ids with equal hashCode get distinct PendingIntent identities via intent data`() {
        assertEquals("Aa".hashCode(), "BB".hashCode())            // the classic Java collision
        assertNotEquals(SchedulerAlarms.identityUri("Aa"), SchedulerAlarms.identityUri("BB"))
        assertTrue(SchedulerAlarms.identityUri("job-1").startsWith("aihangout-job:"))
        assertNotEquals(SchedulerAlarms.identityUri("job-1"), SchedulerAlarms.identityUri("job-1 "))
    }

    // Finding 3: execution is bounded and battery-only; a stall becomes UNKNOWN, never an OS kill with a RUNNING orphan.
    @Test
    fun `bounded execution times out a stalled read and the row becomes UNKNOWN`() {
        val store = MemoryScheduleStore(); pending(store, "j", now)
        assertTrue(SchedulerPolicy.onFire(store, "j", now) is FireDecision.Execute)
        val outcome = BoundedExecution.run(OperationRegistry.BATTERY_STATUS_READ, 200) { Thread.sleep(5_000); "{}" }
        assertTrue(outcome is BoundedExecution.Outcome.TimedOut)
        assertTrue(SchedulerPolicy.finishUnknown(store, "j", now + 200, "execution exceeded 200 ms budget"))
        assertEquals(JobStatus.UNKNOWN, store.get("j")!!.status)
        assertTrue(SchedulerPolicy.onFire(store, "j", now + 300) is FireDecision.Ignore)
    }

    @Test
    fun `bounded execution completes a fast read and refuses non-supported operations before running anything`() {
        val ok = BoundedExecution.run(OperationRegistry.BATTERY_STATUS_READ, 1_000) { "{\"percent\":50}" }
        assertEquals("{\"percent\":50}", (ok as BoundedExecution.Outcome.Completed).resultJson)
        var ran = false
        val refused = BoundedExecution.run("sms_send", 1_000) { ran = true; "{}" }
        assertTrue(refused is BoundedExecution.Outcome.Failed)
        assertTrue(!ran)
        val threw = BoundedExecution.run(OperationRegistry.BATTERY_STATUS_READ, 1_000) { throw IllegalStateException("reader broke") }
        assertTrue((threw as BoundedExecution.Outcome.Failed).error.contains("reader broke"))
        assertTrue(SchedulerPolicy.EXECUTION_BUDGET_MS < 10_000)   // documented broadcast window
    }
}
