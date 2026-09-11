package com.aihangout.companion

import com.aihangout.companion.scheduler.JobStatus
import com.aihangout.companion.scheduler.MemoryScheduleStore
import com.aihangout.companion.scheduler.OperationRegistry
import com.aihangout.companion.scheduler.SchedulerPolicy
import com.aihangout.companion.scheduler.SchedulerPolicy.Approval
import com.aihangout.companion.scheduler.SchedulerPolicy.FireDecision
import com.aihangout.companion.scheduler.ScheduledJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger

class SchedulerPolicyTest {
    private val now = 1_800_000_000_000L
    private fun pendingJob(store: MemoryScheduleStore, fireAt: Long, op: String = OperationRegistry.BATTERY_STATUS_READ, id: String = "job-1"): ScheduledJob {
        val j = ScheduledJob(id, op, fireAt, "UTC", JobStatus.PENDING, now - 1000)
        store.insert(j); return j
    }

    @Test
    fun `approve accepts only the closed supported operation with explicit future time and zone`() {
        val a = SchedulerPolicy.approve("battery_status_read", "2027-06-01T07:30", "America/Chicago", now, id = "j")
        assertTrue(a is Approval.Accepted)
        assertEquals("America/Chicago", (a as Approval.Accepted).job.timeZoneId)
        assertEquals(JobStatus.PENDING, a.job.status)
        assertTrue(SchedulerPolicy.approve("battery_status_read", "2027-06-01T07:30", "Mars/Olympus", now) is Approval.Refused)
        assertTrue(SchedulerPolicy.approve("battery_status_read", "tomorrow morning", "UTC", now) is Approval.Refused)
        assertTrue(SchedulerPolicy.approve("battery_status_read", "2020-01-01T00:00", "UTC", now) is Approval.Refused)
    }

    @Test
    fun `unknown and SMS operation ids are refused at approval AND at fire time`() {
        for (bad in listOf("sms_send", "call_make", "email_send", "run_script", "", null, "Battery_Status_Read")) {
            assertTrue("$bad", SchedulerPolicy.approve(bad, "2027-06-01T07:30", "UTC", now) is Approval.Refused)
        }
        // A row written by an older build with a reserved id must never execute.
        val store = MemoryScheduleStore()
        pendingJob(store, now, op = "sms_send", id = "old")
        val d = SchedulerPolicy.onFire(store, "old", now)
        assertTrue(d is FireDecision.Ignore)
        assertEquals(JobStatus.UNKNOWN, store.get("old")!!.status)
    }

    @Test
    fun `claim-once -- 16 parallel fires admit exactly one execution`() {
        val store = MemoryScheduleStore(); pendingJob(store, now)
        val start = CountDownLatch(1); val done = CountDownLatch(16); val executes = AtomicInteger()
        repeat(16) { Thread { start.await(); if (SchedulerPolicy.onFire(store, "job-1", now) is FireDecision.Execute) executes.incrementAndGet(); done.countDown() }.start() }
        start.countDown(); done.await()
        assertEquals(1, executes.get())
        assertEquals(JobStatus.RUNNING, store.get("job-1")!!.status)
        // A second fire after completion is ignored, never re-run.
        assertTrue(SchedulerPolicy.finishCompleted(store, "job-1", now + 10, "{\"percent\":77}"))
        assertTrue(SchedulerPolicy.onFire(store, "job-1", now + 20) is FireDecision.Ignore)
        assertEquals("{\"percent\":77}", store.get("job-1")!!.resultJson)
    }

    @Test
    fun `cancel works only on PENDING and a cancelled job never fires`() {
        val store = MemoryScheduleStore(); pendingJob(store, now + 60_000)
        assertTrue(SchedulerPolicy.cancel(store, "job-1", now))
        assertEquals(JobStatus.CANCELLED, store.get("job-1")!!.status)
        assertFalse(SchedulerPolicy.cancel(store, "job-1", now))
        assertTrue(SchedulerPolicy.onFire(store, "job-1", now + 60_000) is FireDecision.Ignore)
        pendingJob(store, now, id = "job-2")
        assertTrue(SchedulerPolicy.onFire(store, "job-2", now) is FireDecision.Execute)
        assertFalse("a RUNNING job cannot be cancelled", SchedulerPolicy.cancel(store, "job-2", now))
    }

    @Test
    fun `overdue fire is marked MISSED and not executed`() {
        val store = MemoryScheduleStore(); pendingJob(store, now)
        val late = now + SchedulerPolicy.LATE_TOLERANCE_MS + 1
        assertTrue(SchedulerPolicy.onFire(store, "job-1", late) is FireDecision.Missed)
        assertEquals(JobStatus.MISSED, store.get("job-1")!!.status)
        assertTrue(SchedulerPolicy.onFire(store, "job-1", late) is FireDecision.Ignore)
    }

    @Test
    fun `execution failure after the claim becomes UNKNOWN, never a retry`() {
        val store = MemoryScheduleStore(); pendingJob(store, now)
        assertTrue(SchedulerPolicy.onFire(store, "job-1", now) is FireDecision.Execute)
        assertTrue(SchedulerPolicy.finishUnknown(store, "job-1", now + 5, "reader threw"))
        assertEquals(JobStatus.UNKNOWN, store.get("job-1")!!.status)
        assertFalse(SchedulerPolicy.finishCompleted(store, "job-1", now + 6, "{}"))
    }

    @Test
    fun `boot plan -- future pending rescheduled, overdue pending missed, running quarantined as unknown`() {
        val store = MemoryScheduleStore()
        pendingJob(store, now + 3_600_000, id = "future")
        pendingJob(store, now - 3_600_000, id = "overdue")
        pendingJob(store, now - 60_000, id = "was-running")
        assertTrue(SchedulerPolicy.onFire(store, "was-running", now - 60_000) is FireDecision.Execute) // crashed mid-run
        val plan = SchedulerPolicy.onBoot(store, now)
        assertEquals(listOf("future"), plan.reschedule.map { it.id })
        assertEquals(listOf("overdue"), plan.missed.map { it.id })
        assertEquals(listOf("was-running"), plan.quarantined.map { it.id })
        assertEquals(JobStatus.UNKNOWN, store.get("was-running")!!.status)
        assertEquals(JobStatus.MISSED, store.get("overdue")!!.status)
        assertEquals(JobStatus.PENDING, store.get("future")!!.status)
        // No replay: the quarantined row cannot be claimed again.
        assertTrue(SchedulerPolicy.onFire(store, "was-running", now) is FireDecision.Ignore)
    }
}
