package com.aihangout.companion.scheduler

import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeParseException
import java.util.UUID

/**
 * Pure, JVM-tested rules. Every state change is a CAS on the store, so the
 * same rules hold for the memory store (tests) and SQLite (device):
 *
 *  approve : explicit owner date/time/timezone + closed operation id -> PENDING
 *  fire    : PENDING -> RUNNING claimed exactly once; overdue -> MISSED, never run late
 *  finish  : RUNNING -> COMPLETED (result kept privately) | UNKNOWN (execution threw)
 *  cancel  : PENDING -> CANCELLED only (a RUNNING job cannot be un-run)
 *  boot    : future PENDING -> reschedule; overdue PENDING -> MISSED; RUNNING found
 *            after restart -> UNKNOWN quarantine, no replay
 */
object SchedulerPolicy {
    /** Fire more than this long after its time is "missed": the owner approved a moment, not "sometime later". */
    const val LATE_TOLERANCE_MS: Long = 5 * 60 * 1000
    /** Owner must schedule at least this far ahead so the alarm can actually be set. */
    const val MIN_LEAD_MS: Long = 60 * 1000

    sealed class Approval {
        data class Accepted(val job: ScheduledJob) : Approval()
        data class Refused(val reason: String) : Approval()
    }

    /** [localDateTime] is what the owner typed (ISO, e.g. 2026-09-12T07:30); [zoneId] is explicit, never inferred. */
    fun approve(operationRaw: String?, localDateTime: String, zoneId: String, nowEpochMs: Long, id: String = "job-${UUID.randomUUID()}"): Approval {
        val op = when (val d = OperationRegistry.decide(operationRaw)) {
            is OperationRegistry.Decision.Refused -> return Approval.Refused("operation '${d.id}': ${d.reason}")
            is OperationRegistry.Decision.Supported -> d.id
        }
        val zone = try { ZoneId.of(zoneId) } catch (e: Exception) { return Approval.Refused("time zone '$zoneId' is not a valid zone id") }
        val fireAt = try { LocalDateTime.parse(localDateTime).atZone(zone).toInstant().toEpochMilli() }
            catch (e: DateTimeParseException) { return Approval.Refused("date/time '$localDateTime' is not ISO local date-time (yyyy-MM-ddTHH:mm)") }
        if (fireAt < nowEpochMs + MIN_LEAD_MS) return Approval.Refused("scheduled time must be at least ${MIN_LEAD_MS / 1000}s in the future")
        return Approval.Accepted(ScheduledJob(id, op, fireAt, zone.id, JobStatus.PENDING, nowEpochMs))
    }

    sealed class FireDecision {
        /** This caller won the claim and must execute exactly once, then call [finish]. */
        data class Execute(val job: ScheduledJob) : FireDecision()
        data class Missed(val job: ScheduledJob) : FireDecision()
        /** Not pending (already claimed/cancelled/unknown) or unknown id: do nothing. */
        data class Ignore(val reason: String) : FireDecision()
    }

    fun onFire(store: ScheduleStore, jobId: String, nowEpochMs: Long): FireDecision {
        val job = store.get(jobId) ?: return FireDecision.Ignore("no such job")
        if (job.status != JobStatus.PENDING) return FireDecision.Ignore("job is ${job.status}, not PENDING")
        // Re-check the closed registry at execution time: a row written by an older
        // build with a since-removed or reserved id must never run.
        if (OperationRegistry.decide(job.operation) !is OperationRegistry.Decision.Supported) {
            store.casStatus(jobId, JobStatus.PENDING, JobStatus.UNKNOWN, nowEpochMs, "operation refused at fire time")
            return FireDecision.Ignore("operation '${job.operation}' refused at fire time")
        }
        if (nowEpochMs - job.fireAtEpochMs > LATE_TOLERANCE_MS) {
            return if (store.casStatus(jobId, JobStatus.PENDING, JobStatus.MISSED, nowEpochMs, "fired ${(nowEpochMs - job.fireAtEpochMs) / 1000}s late; not executed"))
                FireDecision.Missed(checkNotNull(store.get(jobId))) else FireDecision.Ignore("lost race while marking missed")
        }
        return if (store.casStatus(jobId, JobStatus.PENDING, JobStatus.RUNNING, nowEpochMs, "claimed"))
            FireDecision.Execute(checkNotNull(store.get(jobId))) else FireDecision.Ignore("another fire already claimed this job")
    }

    fun finishCompleted(store: ScheduleStore, jobId: String, nowEpochMs: Long, resultJson: String): Boolean =
        store.casStatus(jobId, JobStatus.RUNNING, JobStatus.COMPLETED, nowEpochMs, "completed", resultJson)

    fun finishUnknown(store: ScheduleStore, jobId: String, nowEpochMs: Long, why: String): Boolean =
        store.casStatus(jobId, JobStatus.RUNNING, JobStatus.UNKNOWN, nowEpochMs, "execution outcome unknown: $why")

    fun cancel(store: ScheduleStore, jobId: String, nowEpochMs: Long): Boolean =
        store.casStatus(jobId, JobStatus.PENDING, JobStatus.CANCELLED, nowEpochMs, "cancelled by owner")

    data class BootPlan(val reschedule: List<ScheduledJob>, val missed: List<ScheduledJob>, val quarantined: List<ScheduledJob>)

    fun onBoot(store: ScheduleStore, nowEpochMs: Long): BootPlan {
        val reschedule = mutableListOf<ScheduledJob>(); val missed = mutableListOf<ScheduledJob>(); val quarantined = mutableListOf<ScheduledJob>()
        for (job in store.list()) when (job.status) {
            JobStatus.PENDING -> if (job.fireAtEpochMs > nowEpochMs) reschedule += job
                else if (store.casStatus(job.id, JobStatus.PENDING, JobStatus.MISSED, nowEpochMs, "overdue at boot; not executed")) missed += checkNotNull(store.get(job.id))
            JobStatus.RUNNING -> if (store.casStatus(job.id, JobStatus.RUNNING, JobStatus.UNKNOWN, nowEpochMs, "found RUNNING after restart; quarantined, no replay")) quarantined += checkNotNull(store.get(job.id))
            else -> Unit
        }
        return BootPlan(reschedule, missed, quarantined)
    }

    fun describe(job: ScheduledJob): String {
        val local = Instant.ofEpochMilli(job.fireAtEpochMs).atZone(ZoneId.of(job.timeZoneId)).toLocalDateTime()
        return "${job.operation} at $local ${job.timeZoneId} -- ${job.status}${job.note?.let { " ($it)" } ?: ""}"
    }
}
