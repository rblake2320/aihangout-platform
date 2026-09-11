package com.aihangout.companion.ui

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.aihangout.companion.BuildConfig
import com.aihangout.companion.diagnostics.AndroidNetworkObserver
import com.aihangout.companion.diagnostics.NetworkClassifier
import com.aihangout.companion.diagnostics.NetworkReport

/**
 * Separate, non-exported screen for read-only network diagnostics. It never
 * creates an action intent, never touches the journal or approval gates, and
 * never uploads anything: the human taps, the observation + rule-based
 * verdict are shown, and a timestamped report is saved app-private.
 */
class NetworkDiagnosticsActivity : AppCompatActivity() {
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val out = TextView(this).apply {
            text = "Read-only network check. Observes the active network's transport and Android's validated/captive flags, " +
                "and makes ONE bounded HTTPS request to ${BuildConfig.AIHANGOUT_BASE_URL}/api/health. " +
                "No scans, no router changes, no SSID/location collection, no upload."
        }
        val button = Button(this).apply { text = "Run read-only network check" }
        val shareButton = Button(this).apply { text = "Share minimal report... (you pick the app; nothing is sent automatically)"; isEnabled = false }
        var lastShareText: String? = null
        shareButton.setOnClickListener {
            val body = lastShareText ?: return@setOnClickListener
            // Deliberate user hand-off via the system chooser (ACTION_SEND, text/plain).
            // The app never interprets the report itself and never picks a recipient.
            val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(android.content.Intent.EXTRA_SUBJECT, "AIHangout companion network diagnostic")
                putExtra(android.content.Intent.EXTRA_TEXT, body)
            }
            startActivity(android.content.Intent.createChooser(send, "Share diagnostic with..."))
        }
        button.setOnClickListener {
            button.isEnabled = false
            Thread {
                val text = try {
                    val observer = AndroidNetworkObserver(this, BuildConfig.AIHANGOUT_BASE_URL)
                    val observation = observer.observe()
                    val verdict = NetworkClassifier.classify(observation)
                    val capturedAt = AndroidNetworkObserver.nowIso()
                    val report = NetworkReport.build(observation, verdict, capturedAt, BuildConfig.VERSION_NAME)
                    val share = NetworkReport.shareText(observation, verdict, capturedAt)
                    mainHandler.post { lastShareText = share; shareButton.isEnabled = true }
                    val saved = try { "Saved privately: ${observer.saveReport(report).name}" } catch (e: Exception) { "Report NOT saved (${e.javaClass.simpleName}: ${e.message})" }
                    "Verdict: ${verdict.category}\n${verdict.explanation}\n[${verdict.source}]\n\n" +
                        "Observation: transport=${observation.transport} validated=${observation.validated} captive=${observation.captivePortal} " +
                        "internetCap=${observation.hasInternetCapability} metered=${observation.metered}\nProbe: ${observation.probe.toJson()}\n$saved"
                } catch (e: Exception) {
                    "Diagnostics failed (${e.javaClass.simpleName}: ${e.message}). Nothing was changed."
                }
                mainHandler.post { out.text = "${out.text}\n\n$text"; button.isEnabled = true }
            }.start()
        }
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(48, 48, 48, 48)
            addView(button); addView(shareButton); addView(out)
        }
        setContentView(ScrollView(this).apply { addView(layout) })
    }
}
