package com.aihangout.companion.scheduler

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * On-device store. The CAS is a single UPDATE ... WHERE id=? AND status=?
 * evaluated by SQLite atomically; exactly one caller can win a transition.
 * Not JVM-tested (framework class); MemoryScheduleStore carries the tested
 * semantics and the policy layer is identical for both.
 */
class SqliteScheduleStore(context: Context) : SQLiteOpenHelper(context, "companion_scheduler.db", null, 1), ScheduleStore {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE jobs (
                 id TEXT PRIMARY KEY, operation TEXT NOT NULL, fire_at INTEGER NOT NULL, tz TEXT NOT NULL,
                 status TEXT NOT NULL, created_at INTEGER NOT NULL, claimed_at INTEGER, finished_at INTEGER,
                 result_json TEXT, note TEXT)"""
        )
        db.execSQL("CREATE INDEX idx_jobs_status_fire ON jobs(status, fire_at)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) { /* v1 only */ }

    override fun insert(job: ScheduledJob) {
        val cv = ContentValues().apply {
            put("id", job.id); put("operation", job.operation); put("fire_at", job.fireAtEpochMs); put("tz", job.timeZoneId)
            put("status", job.status.name); put("created_at", job.createdAtEpochMs)
            put("claimed_at", job.claimedAtEpochMs); put("finished_at", job.finishedAtEpochMs)
            put("result_json", job.resultJson); put("note", job.note)
        }
        writableDatabase.insertOrThrow("jobs", null, cv)
    }

    override fun get(id: String): ScheduledJob? =
        readableDatabase.query("jobs", null, "id = ?", arrayOf(id), null, null, null).use { c -> if (c.moveToFirst()) row(c) else null }

    override fun list(): List<ScheduledJob> =
        readableDatabase.query("jobs", null, null, null, null, null, "fire_at ASC").use { c ->
            generateSequence { if (c.moveToNext()) row(c) else null }.toList()
        }

    override fun casStatus(id: String, expected: JobStatus, next: JobStatus, nowEpochMs: Long, note: String?, resultJson: String?): Boolean {
        val cv = ContentValues().apply {
            put("status", next.name)
            if (next == JobStatus.RUNNING) put("claimed_at", nowEpochMs)
            if (next == JobStatus.COMPLETED || next == JobStatus.MISSED || next == JobStatus.CANCELLED || next == JobStatus.UNKNOWN) put("finished_at", nowEpochMs)
            if (resultJson != null) put("result_json", resultJson)
            if (note != null) put("note", note)
        }
        // Atomic conditional update: the WHERE clause is the compare, the row count is the set.
        return writableDatabase.update("jobs", cv, "id = ? AND status = ?", arrayOf(id, expected.name)) == 1
    }

    private fun row(c: android.database.Cursor): ScheduledJob = ScheduledJob(
        id = c.getString(c.getColumnIndexOrThrow("id")),
        operation = c.getString(c.getColumnIndexOrThrow("operation")),
        fireAtEpochMs = c.getLong(c.getColumnIndexOrThrow("fire_at")),
        timeZoneId = c.getString(c.getColumnIndexOrThrow("tz")),
        status = JobStatus.valueOf(c.getString(c.getColumnIndexOrThrow("status"))),
        createdAtEpochMs = c.getLong(c.getColumnIndexOrThrow("created_at")),
        claimedAtEpochMs = c.getColumnIndexOrThrow("claimed_at").let { if (c.isNull(it)) null else c.getLong(it) },
        finishedAtEpochMs = c.getColumnIndexOrThrow("finished_at").let { if (c.isNull(it)) null else c.getLong(it) },
        resultJson = c.getColumnIndexOrThrow("result_json").let { if (c.isNull(it)) null else c.getString(it) },
        note = c.getColumnIndexOrThrow("note").let { if (c.isNull(it)) null else c.getString(it) }
    )
}
