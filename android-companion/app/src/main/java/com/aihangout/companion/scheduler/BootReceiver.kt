package com.aihangout.companion.scheduler

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Alarms are cleared on reboot AND on package update (official guide): re-set
 * future PENDING jobs, mark overdue ones MISSED (never executed late),
 * quarantine RUNNING rows. Handles BOOT_COMPLETED and MY_PACKAGE_REPLACED. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val store = SqliteScheduleStore(context)
        try {
            val plan = SchedulerPolicy.reconcile(store, System.currentTimeMillis())
            plan.reschedule.forEach { job ->
                if (!SchedulerAlarms.schedule(context, job)) {
                    // Permission lost across the reboot: leave the row PENDING and visible; do not guess.
                    store.casStatus(job.id, JobStatus.PENDING, JobStatus.PENDING, System.currentTimeMillis(), "exact-alarm permission missing at boot; not rescheduled")
                }
            }
        } finally { store.close() }
    }
}
