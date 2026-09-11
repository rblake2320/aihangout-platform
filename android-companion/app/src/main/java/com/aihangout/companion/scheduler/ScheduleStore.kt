package com.aihangout.companion.scheduler

/**
 * Durable job state with an ATOMIC compare-and-set on status. Every
 * transition that matters for exactly-once execution goes through [casStatus]:
 * the alarm receiver may only run a job it moved PENDING->RUNNING itself, and
 * a concurrent/duplicate fire loses the CAS and does nothing.
 */
interface ScheduleStore {
    fun insert(job: ScheduledJob)
    fun get(id: String): ScheduledJob?
    fun list(): List<ScheduledJob>

    /** Atomically: if status == [expected] then set [next] (+timestamps/note) and return true; else false. */
    fun casStatus(id: String, expected: JobStatus, next: JobStatus, nowEpochMs: Long, note: String? = null, resultJson: String? = null): Boolean
}

/** In-memory implementation for JVM tests; the same semantics the SQLite store provides on-device. */
class MemoryScheduleStore : ScheduleStore {
    private val jobs = LinkedHashMap<String, ScheduledJob>()
    private val lock = Any()

    override fun insert(job: ScheduledJob) { synchronized(lock) { require(!jobs.containsKey(job.id)) { "duplicate job id" }; jobs[job.id] = job } }
    override fun get(id: String): ScheduledJob? = synchronized(lock) { jobs[id] }
    override fun list(): List<ScheduledJob> = synchronized(lock) { jobs.values.toList() }

    override fun casStatus(id: String, expected: JobStatus, next: JobStatus, nowEpochMs: Long, note: String?, resultJson: String?): Boolean = synchronized(lock) {
        val j = jobs[id] ?: return false
        if (j.status != expected) return false
        jobs[id] = j.copy(
            status = next,
            claimedAtEpochMs = if (next == JobStatus.RUNNING) nowEpochMs else j.claimedAtEpochMs,
            finishedAtEpochMs = if (next == JobStatus.COMPLETED || next == JobStatus.MISSED || next == JobStatus.CANCELLED || next == JobStatus.UNKNOWN) nowEpochMs else j.finishedAtEpochMs,
            resultJson = resultJson ?: j.resultJson,
            note = note ?: j.note
        )
        true
    }
}
