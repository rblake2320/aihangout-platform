package com.aihangout.companion.scheduler

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings

/**
 * AlarmManager wiring (framework; not JVM-tested). Exact alarms are gated by
 * canScheduleExactAlarms() on API 31+ per the official guide -- the permission
 * is not pre-granted on fresh installs targeting 33+, so the Activity hands the
 * owner to the system "Alarms & reminders" page instead of silently degrading.
 */
object SchedulerAlarms {
    const val ACTION_FIRE = "com.aihangout.companion.scheduler.FIRE"
    const val EXTRA_JOB_ID = "jobId"

    fun canScheduleExact(context: Context): Boolean {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
    }

    /** Settings hand-off; only meaningful on API 31+. */
    fun requestExactPermissionIntent(context: Context): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply { data = android.net.Uri.parse("package:${context.packageName}") }
        else null

    private fun pending(context: Context, jobId: String): PendingIntent {
        val intent = Intent(context, ScheduleAlarmReceiver::class.java).setAction(ACTION_FIRE).putExtra(EXTRA_JOB_ID, jobId)
        // Request code from the job id keeps one PendingIntent per job; IMMUTABLE so no other app can rewrite the extras.
        return PendingIntent.getBroadcast(context, jobId.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** Returns false (nothing set) when the exact-alarm permission is missing; the row stays PENDING for the owner to act. */
    fun schedule(context: Context, job: ScheduledJob): Boolean {
        if (!canScheduleExact(context)) return false
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, job.fireAtEpochMs, pending(context, job.id))
        return true
    }

    fun cancel(context: Context, jobId: String) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.cancel(pending(context, jobId))
    }
}
