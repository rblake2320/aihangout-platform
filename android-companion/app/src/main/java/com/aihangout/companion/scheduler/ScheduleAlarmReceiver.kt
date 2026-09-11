package com.aihangout.companion.scheduler

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.aihangout.companion.diagnostics.AndroidDeviceReader
import com.aihangout.companion.diagnostics.ResultHasher

/**
 * Fires for one job id. Claims via CAS first (exactly once), executes ONLY the
 * supported read-only operation, stores the private result, and never
 * re-runs: any exception after the claim moves the row to UNKNOWN.
 */
class ScheduleAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != SchedulerAlarms.ACTION_FIRE) return
        val jobId = intent.getStringExtra(SchedulerAlarms.EXTRA_JOB_ID) ?: return
        val store = SqliteScheduleStore(context)
        val now = System.currentTimeMillis()
        val pendingResult = goAsync()
        Thread {
            try {
                when (val d = SchedulerPolicy.onFire(store, jobId, now)) {
                    is SchedulerPolicy.FireDecision.Execute -> execute(context, store, d.job)
                    is SchedulerPolicy.FireDecision.Missed, is SchedulerPolicy.FireDecision.Ignore -> Unit
                }
            } finally {
                store.close()
                pendingResult.finish()
            }
        }.start()
    }

    private fun execute(context: Context, store: ScheduleStore, job: ScheduledJob) {
        try {
            val result = when (job.operation) {
                OperationRegistry.BATTERY_STATUS_READ -> ResultHasher.batteryStatusJson(AndroidDeviceReader(context).readBatteryStatus())
                else -> throw IllegalStateException("unsupported operation reached execute(): ${job.operation}")
            }
            SchedulerPolicy.finishCompleted(store, job.id, System.currentTimeMillis(), result)
        } catch (e: Exception) {
            SchedulerPolicy.finishUnknown(store, job.id, System.currentTimeMillis(), "${e.javaClass.simpleName}: ${e.message}")
        }
    }
}
