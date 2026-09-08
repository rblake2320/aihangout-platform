package com.aihangout.companion.ui

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.aihangout.companion.BuildConfig
import com.aihangout.companion.crypto.DeviceKeyManager
import com.aihangout.companion.data.TokenStore
import com.aihangout.companion.diagnostics.AndroidDeviceReader
import com.aihangout.companion.diagnostics.ResultHasher
import com.aihangout.companion.net.AihangoutApi
import java.util.UUID

/**
 * Minimal, functional first-milestone UI -- deliberately plain (no
 * Compose/theming polish) so this pass stays focused on proving the real
 * enroll -> intent -> poll-for-approval -> read -> hash -> report ->
 * readback flow actually works end-to-end against the real backend.
 * Approval itself happens on the AIHangout WEB frontend, per the
 * approval-UX design ("the mobile agent cannot approve itself") -- this
 * screen only polls for the human's decision, it never renders an
 * Approve control of its own.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var statusView: TextView
    private lateinit var tokenStore: TokenStore
    private lateinit var api: AihangoutApi
    private lateinit var keyManager: DeviceKeyManager
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        tokenStore = TokenStore(this)
        api = AihangoutApi(BuildConfig.AIHANGOUT_BASE_URL)
        keyManager = DeviceKeyManager(this)

        val emailInput = EditText(this).apply { hint = "Email" }
        val passwordInput = EditText(this).apply {
            hint = "Password"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val agentNameInput = EditText(this).apply { hint = "Agent name (device nickname)"; setText("android-companion-1") }
        val runButton = Button(this).apply { text = "Enroll + run one battery-status check" }
        statusView = TextView(this).apply { text = "Idle." }

        runButton.setOnClickListener {
            val email = emailInput.text.toString()
            val password = passwordInput.text.toString()
            val agentName = agentNameInput.text.toString()
            runButton.isEnabled = false
            Thread { runFlow(email, password, agentName, runButton) }.start()
        }

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
            addView(emailInput)
            addView(passwordInput)
            addView(agentNameInput)
            addView(runButton)
            addView(statusView)
        }
        setContentView(ScrollView(this).apply { addView(layout) })
    }

    private fun log(line: String) {
        mainHandler.post { statusView.text = "${statusView.text}\n$line" }
    }

    /** Runs on a background thread -- all network/crypto calls here are
     * blocking, deliberately kept off the main thread. */
    private fun runFlow(email: String, password: String, agentName: String, runButton: Button) {
        try {
            log("Logging in...")
            val jwt = api.login(email, password)
            tokenStore.jwt = jwt
            log("Logged in.")

            log("Ensuring device key exists...")
            keyManager.ensureKeyExists()
            val spki = keyManager.exportPublicKeySpkiBase64()
            val packageName = keyManager.packageName()
            val certSha256 = keyManager.signingCertSha256()

            var deviceId = tokenStore.deviceId
            if (deviceId == null) {
                log("Requesting enrollment challenge...")
                val challenge = api.requestChallenge(jwt, agentName, spki, packageName, certSha256)
                val challengeId = challenge.getString("challengeId")
                val signingPayload = challenge.getString("signingPayload")
                log("Signing challenge with device key...")
                val signature = keyManager.signPayload(signingPayload)
                log("Enrolling...")
                val enrollResult = api.enroll(jwt, agentName, spki, packageName, certSha256, challengeId, signature)
                deviceId = enrollResult.getString("deviceId")
                tokenStore.deviceId = deviceId
                log("Enrolled. deviceId=$deviceId")
            } else {
                log("Already enrolled. deviceId=$deviceId")
            }

            // Kotlin does not smart-cast a reassigned `var` across the
            // if/else above; both branches guarantee a non-null value by
            // this point, so bind it once to a val instead of relying on
            // (and fighting) that limitation.
            val resolvedDeviceId = deviceId ?: throw IllegalStateException("deviceId was not set after enrollment")

            log("Creating a battery_status_read action intent...")
            val idempotencyKey = "android-${UUID.randomUUID()}"
            val intent = api.createIntent(jwt, resolvedDeviceId, "battery_status_read", "Check battery percent and charging state", idempotencyKey)
            val actionId = intent.getString("actionId")
            log("Intent created: actionId=$actionId. Approve it on the AIHangout web app now.")

            log("Polling for approval (up to 15 minutes, checking every 5s)...")
            var approved = false
            val deadline = System.currentTimeMillis() + 15 * 60 * 1000
            while (System.currentTimeMillis() < deadline) {
                val readback = api.getAction(jwt, actionId)
                val status = readback.getJSONObject("intent").getString("status")
                if (status == "approved") { approved = true; break }
                if (status == "expired" || status == "denied" || status == "revoked") {
                    log("Action ended with status=$status, stopping.")
                    break
                }
                Thread.sleep(5000)
            }

            if (!approved) {
                log("Not approved (timed out or denied). Stopping without executing anything.")
                return
            }

            log("Approved. Reading battery status...")
            val reader = AndroidDeviceReader(this)
            val battery = reader.readBatteryStatus()
            val contentJson = ResultHasher.batteryStatusJson(battery)
            val hash = ResultHasher.hashStructuredResult(
                capability = "battery_status_read", actionId = actionId, deviceId = resolvedDeviceId,
                redactionPolicy = ResultHasher.REDACTION_POLICY_STRUCTURED_FIELDS_V1, contentJson = contentJson
            )
            log("Read: percent=${battery.percent} charging=${battery.isCharging}. Reporting only the hash, never the raw reading, to the backend.")

            api.reportResult(jwt, actionId, resolvedDeviceId, idempotencyKey, "executed", hash)
            log("Result reported. Reading back final state...")
            val finalState = api.getAction(jwt, actionId)
            log("Final state: ${finalState.toString(2)}")
        } catch (e: Exception) {
            log("ERROR: ${e.message}")
        } finally {
            mainHandler.post { runButton.isEnabled = true }
        }
    }
}
