package com.aihangout.companion.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.CalendarContract
import android.provider.Settings
import android.speech.RecognizerIntent
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

/** Local explicit handoffs. Launching another app is not proof it completed an operation. */
class PhoneToolsActivity : AppCompatActivity() {
    private lateinit var status: TextView
    private lateinit var proposal: TextView
    private var pending: String? = null
    private val voice = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val words = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        pending = when (words?.trim()?.lowercase()) {
            "open calendar" -> "calendar"
            "open app settings" -> "apps"
            "open camera notes" -> "camera"
            else -> null
        }
        proposal.text = if (pending == null) "No supported proposal. Say: open calendar, open app settings, or open camera notes."
            else "Heard: $words\nProposed: $pending. Tap Confirm to open; nothing has run yet."
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        status = TextView(this).apply { text = "System handoffs require your interaction. No silent install, deletion or calendar write." }
        proposal = TextView(this)
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32,48,32,32) }
        fun button(label: String, action: () -> Unit) { layout.addView(Button(this).apply { text=label; setOnClickListener { action() } }) }
        layout.addView(TextView(this).apply { text="Phone tools"; textSize=24f })
        layout.addView(status)
        button("Open calendar") { execute("calendar") }
        button("Draft test calendar event (review before saving)") {
            launch(Intent(Intent.ACTION_INSERT, CalendarContract.Events.CONTENT_URI)
                .putExtra(CalendarContract.Events.TITLE,"AIHangout test - review before saving"))
        }
        button("App management (Android settings)") { execute("apps") }
        button("Companion app details") { launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
        button("Speak a supported command") {
            pending=null
            try { voice.launch(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PROMPT,"Open calendar, open app settings, or open camera notes")) }
            catch (e: RuntimeException) { status.text="Speech input unavailable: ${e.javaClass.simpleName}" }
        }
        layout.addView(proposal)
        button("Confirm proposed handoff") { val operation=pending; pending=null; if(operation!=null) execute(operation) else status.text="No supported proposal to confirm." }
        setContentView(ScrollView(this).apply { addView(layout) })
    }
    private fun execute(operation: String) {
        when(operation) {
            "calendar" -> launch(Intent(Intent.ACTION_VIEW, Uri.parse("content://com.android.calendar/time/${System.currentTimeMillis()}")))
            "apps" -> launch(Intent(Settings.ACTION_MANAGE_APPLICATIONS_SETTINGS))
            "camera" -> launch(Intent(this,CameraNotesActivity::class.java))
            else -> { status.text="Unsupported operation; nothing launched." }
        }
    }
    private fun launch(intent: Intent) {
        try { startActivity(intent); status.text="Handoff requested. Completion has not been verified." }
        catch(e: RuntimeException) { status.text="Handoff unavailable: ${e.javaClass.simpleName}. Nothing verified." }
    }
}
