package com.aihangout.companion.ui

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.aihangout.companion.scheduler.JobStatus
import com.aihangout.companion.scheduler.OperationRegistry
import com.aihangout.companion.scheduler.SchedulerAlarms
import com.aihangout.companion.scheduler.SchedulerPolicy
import com.aihangout.companion.scheduler.SqliteScheduleStore
import java.time.ZoneId

/**
 * Separate, non-exported screen: the owner explicitly approves ONE closed
 * operation at an explicit local date/time in an explicit time zone, can
 * cancel a pending job, and sees every job's durable state. Nothing here
 * accepts scripts, calendar titles, or free-form operations.
 */
class SchedulerActivity : AppCompatActivity() {
    private lateinit var store: SqliteScheduleStore
    private lateinit var listView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = SqliteScheduleStore(this)

        val intro = TextView(this).apply {
            text = "Phone-local scheduler. Supported operation: ${OperationRegistry.SUPPORTED.joinToString()} (read-only, result kept private on this phone). " +
                "Reserved and refused until a governed adapter exists: ${OperationRegistry.RESERVED_REFUSED.joinToString()}."
        }
        val permView = TextView(this)
        val permButton = Button(this).apply { text = "Open 'Alarms & reminders' setting" }
        permButton.setOnClickListener { SchedulerAlarms.requestExactPermissionIntent(this)?.let { startActivity(it) } }

        val opInput = EditText(this).apply { hint = "operation id"; setText(OperationRegistry.BATTERY_STATUS_READ) }
        val whenInput = EditText(this).apply { hint = "local date/time, ISO (e.g. 2026-09-12T07:30)" }
        val tzInput = EditText(this).apply { hint = "time zone id"; setText(ZoneId.systemDefault().id) }
        val approve = Button(this).apply { text = "Approve this schedule" }
        val cancelInput = EditText(this).apply { hint = "job id to cancel" }
        val cancel = Button(this).apply { text = "Cancel pending job" }
        listView = TextView(this)

        approve.setOnClickListener {
            when (val a = SchedulerPolicy.approve(opInput.text.toString(), whenInput.text.toString().trim(), tzInput.text.toString().trim(), System.currentTimeMillis())) {
                is SchedulerPolicy.Approval.Refused -> listView.text = "REFUSED: ${a.reason}\n\n${render()}"
                is SchedulerPolicy.Approval.Accepted -> {
                    store.insert(a.job)
                    val set = SchedulerAlarms.schedule(this, a.job)
                    listView.text = (if (set) "Approved and alarm set: ${a.job.id}" else "Approved and saved as PENDING, but the exact-alarm permission is missing -- grant it above, then reopen this screen to set the alarm: ${a.job.id}") + "\n\n" + render()
                }
            }
        }
        cancel.setOnClickListener {
            val id = cancelInput.text.toString().trim()
            val ok = SchedulerPolicy.cancel(store, id, System.currentTimeMillis())
            if (ok) SchedulerAlarms.cancel(this, id)
            listView.text = (if (ok) "Cancelled $id" else "Not cancelled: '$id' is not a PENDING job") + "\n\n" + render()
        }

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(48, 48, 48, 48)
            listOf(intro, permView, permButton, opInput, whenInput, tzInput, approve, cancelInput, cancel, listView).forEach { addView(it) }
        }
        setContentView(ScrollView(this).apply { addView(layout) })
        permView.text = permissionLine()
        // Reconcile on every app start (A5 finding 1): quarantine RUNNING rows left by
        // a killed receiver, mark overdue PENDING rows MISSED -- not only on reboot.
        val plan = SchedulerPolicy.reconcile(store, System.currentTimeMillis())
        // Re-arm any future PENDING job whose alarm could not be set earlier (permission granted since).
        if (SchedulerAlarms.canScheduleExact(this)) {
            store.list().filter { it.status == JobStatus.PENDING && it.fireAtEpochMs > System.currentTimeMillis() }.forEach { SchedulerAlarms.schedule(this, it) }
        }
        listView.text = render()
    }

    private fun permissionLine() = "Exact alarms: ${if (SchedulerAlarms.canScheduleExact(this)) "permitted" else "NOT permitted (Android 12+ setting) -- schedules will be saved but not armed"}"

    private fun render(): String = store.list().joinToString("\n") { "${it.id}\n  ${SchedulerPolicy.describe(it)}${it.resultJson?.let { r -> "\n  result (private): $r" } ?: ""}" }.ifEmpty { "No scheduled jobs." }

    override fun onResume() { super.onResume(); listView.text = render() }
    override fun onDestroy() { store.close(); super.onDestroy() }
}
