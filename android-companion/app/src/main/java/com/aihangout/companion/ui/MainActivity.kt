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
import com.aihangout.companion.crypto.SigningPayloadValidator
import com.aihangout.companion.data.ActionJournal
import com.aihangout.companion.data.ReopenDecision
import com.aihangout.companion.data.TokenStore
import com.aihangout.companion.diagnostics.AndroidDeviceReader
import com.aihangout.companion.diagnostics.ResultHasher
import com.aihangout.companion.digest.ActionApprovalVerifier
import com.aihangout.companion.net.AihangoutApi
import com.aihangout.companion.net.AihangoutApiException
import org.json.JSONObject
import java.io.IOException
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
        statusView = TextView(this).apply { text = tokenStore.lastResult ?: "Idle." }

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
        // A6 artifact review flagged unbounded response/error text reaching
        // this visible panel; bounding length is a cheap, real limit even
        // though most messages here are already hand-authored to be safe.
        val bounded = if (line.length > 2000) line.take(2000) + "… [truncated]" else line
        mainHandler.post { statusView.text = "${statusView.text}\n$bounded" }
    }

    /** Allowlisted rendering of the final action state -- replaces the
     * prior raw finalState.toString(2) dump A6's artifact review flagged
     * as an unbounded, unredacted response-disclosure boundary. */
    private fun renderFinalState(finalState: JSONObject): String {
        val intent = finalState.optJSONObject("intent")
        val result = finalState.optJSONObject("result")
        val effect = finalState.optJSONObject("effect")
        return "Final state: status=${intent?.optString("status")} " +
            "resultStatus=${result?.optString("result_status") ?: "none"} " +
            "effectStatus=${effect?.optString("effect_status") ?: "none"}"
    }

    /**
     * Per Team/tasks/A1-to-A3-enrollment-contract-20260908.md: "Unknown
     * outcomes must not blindly re-enroll." A single call to /enroll can
     * fail three genuinely different ways, and this function never
     * conflates them:
     *
     * 1. A clean HTTP error response (AihangoutApiException) -- the
     *    server definitely processed the request and definitely refused
     *    it. Safe to report to the human directly; safe to let them
     *    retry with a fresh attempt (a NEW challenge, never the same
     *    challengeId/signature -- the server's D1 transaction makes a
     *    challenge single-use regardless, so a literal retry with the
     *    same signed transcript cannot succeed anyway). The 409
     *    "Enrollment conflicts with an existing device" case is
     *    special-cased with an actionable message rather than a raw
     *    error dump, since it is the single most likely real-world
     *    outcome of exactly the ambiguous case in point 2 below.
     * 2. A network-level failure (IOException -- timeout, connection
     *    reset, no response received at all) -- the server may or may
     *    not have actually completed the enrollment before the response
     *    was lost. This function does NOT retry automatically on this
     *    path. It throws a clearly labeled exception so the caller
     *    (runFlow) surfaces an explicit "outcome unknown, do not retry
     *    blindly" message instead of silently trying again -- an
     *    automatic retry here could attempt a second enrollment while
     *    the first may have already succeeded.
     * 3. This device's own local claim validation failing
     *    (SigningPayloadValidator) -- the app refuses to sign at all;
     *    nothing was sent to the server, so this is always safe to
     *    surface directly and safe to retry (a fresh challenge starts
     *    the whole transcript over).
     */
    class UnknownEnrollmentOutcomeException(message: String, cause: Throwable) : Exception(message, cause)

    private fun enrollDevice(
        jwt: String, ownerUserId: String, agentName: String, spki: String, packageName: String, certSha256: String,
        journal: ActionJournal
    ): String {
        log("Requesting enrollment challenge...")
        val challenge = api.requestChallenge(jwt, agentName, spki, packageName, certSha256)
        val challengeId = challenge.getString("challengeId")
        val nonce = challenge.getString("nonce")
        val signingPayload = challenge.getString("signingPayload")

        log("Validating the server's signing transcript against what this device actually submitted...")
        SigningPayloadValidator.validate(
            signingPayload,
            SigningPayloadValidator.ExpectedClaims(
                challengeId = challengeId, nonce = nonce, ownerUserId = ownerUserId, agentName = agentName,
                publicKeySpki = spki, packageName = packageName, signingCertSha256 = certSha256
            )
        )
        // Validation passed: every claim in signingPayload is exactly
        // what this device locally submitted/received. Safe to sign.

        log("Signing challenge with device key...")
        val signature = keyManager.signPayload(signingPayload)

        log("Enrolling...")
        // Write-ahead: the enrollment-unknown lock is persisted (commit())
        // BEFORE the POST and only cleared once the server's decision is
        // definitely known. A process death mid-POST therefore also leaves
        // the lock in place, not just the IOException path below.
        journal.lockEnrollmentUnknown(agentName, ownerUserId, BuildConfig.AIHANGOUT_BASE_URL)
        try {
            val enrollResult = api.enroll(jwt, agentName, spki, packageName, certSha256, challengeId, signature)
            val deviceId = enrollResult.getString("deviceId")
            val assurance = enrollResult.optString("assurance", "unknown")
            val keySecurityLevel = enrollResult.optString("keySecurityLevel", "unknown")
            log("Enrolled. deviceId=$deviceId assurance=$assurance keySecurityLevel=$keySecurityLevel")
            // deviceId is persisted by the caller before the lock is cleared;
            // clearing here first would risk losing a confirmed enrollment.
            return deviceId
        } catch (e: AihangoutApiException) {
            // Clean HTTP-level response -- the server definitely decided.
            journal.clearEnrollmentUnknown()
            if (e.httpStatus == 409) {
                log("Enrollment conflicts with an existing device under this agent name. " +
                    "This usually means a PRIOR enrollment attempt actually succeeded even though " +
                    "its response was lost -- do not blindly retry with a new agent name; check " +
                    "whether you already have a device enrolled before creating a duplicate.")
            }
            throw e
        } catch (e: IOException) {
            // Ambiguous -- the request may have reached and been processed
            // by the server; we simply never received its response.
            // Deliberately NOT retried here; the lock written above stays.
            throw UnknownEnrollmentOutcomeException(
                "Enrollment outcome is UNKNOWN (network error after the request may have already " +
                    "reached the server): ${e.message}. Do not tap the button again blindly -- that could " +
                    "attempt a second enrollment while the first may have already succeeded.",
                e
            )
        }
    }

    /** Runs on a background thread -- all network/crypto calls here are
     * blocking, deliberately kept off the main thread. */
    private fun runFlow(email: String, password: String, agentName: String, runButton: Button) {
        try {
            log("Logging in...")
            val loginResult = api.login(email, password)
            val jwt = loginResult.jwt
            tokenStore.jwt = jwt
            log("Logged in.")

            log("Ensuring device key exists...")
            keyManager.ensureKeyExists()
            val spki = keyManager.exportPublicKeySpkiBase64()
            val packageName = keyManager.packageName()
            val certSha256 = keyManager.signingCertSha256()

            // The journal is bound to THIS login's userId and base URL, so a
            // journal left behind by another account or backend is refused
            // (FOREIGN_JOURNAL) instead of being resumed.
            val journal = ActionJournal(tokenStore.phaseStore, loginResult.userId, BuildConfig.AIHANGOUT_BASE_URL)

            var deviceId = tokenStore.deviceId
            if (deviceId == null) {
                if (journal.enrollmentUnknown()) {
                    log("Enrollment outcome unresolved -- needs backend reconciliation. A previous enrollment " +
                        "attempt's outcome was never confirmed (lock 'enrollment_unknown' is set); refusing to " +
                        "start a new enrollment until an operator reconciles it against the backend and clears the lock.")
                    return
                }
                deviceId = enrollDevice(jwt, loginResult.userId, agentName, spki, packageName, certSha256, journal)
                tokenStore.deviceId = deviceId
                journal.clearEnrollmentUnknown()
            } else {
                log("Already enrolled. deviceId=$deviceId")
            }

            // Kotlin does not smart-cast a reassigned `var` across the
            // if/else above; both branches guarantee a non-null value by
            // this point, so bind it once to a val instead of relying on
            // (and fighting) that limitation.
            val resolvedDeviceId = deviceId ?: throw IllegalStateException("deviceId was not set after enrollment")

            // Per Team/tasks/A2-to-A3-mobile-client-blockers-20260908.md (A2's
            // rejection of the apply()-after-POST blob): reopen the write-ahead
            // journal first and branch on its pure decision. The server is
            // read back ONLY when the journal actually holds an actionId.
            val state = journal.load()
            val (actionId, idempotencyKey, expectedAction) = if (state != null) {
                if (!journal.belongsToCurrentSession(state)) {
                    log("FOREIGN_JOURNAL: the persisted action journal belongs to owner=${state.ownerUserId} " +
                        "baseUrl=${state.baseUrl}, not this session. Refusing to resume it; stopping.")
                    return
                }
                log("Found an action journal from a previous run (phase=${state.phase}, actionId=${state.actionId ?: "none"}). Reconciling before doing anything new...")
                val readback = state.actionId?.let { api.getAction(jwt, it) }
                val decision = journal.decide(state, readback)
                log("Reopen decision: ${decision.outcome} -- ${decision.reason}")
                when (decision.outcome) {
                    ReopenDecision.Outcome.FOREIGN_JOURNAL, ReopenDecision.Outcome.UNRESOLVED_CREATE,
                    ReopenDecision.Outcome.QUARANTINE_EFFECT_UNKNOWN,
                    ReopenDecision.Outcome.QUARANTINE_RESULT_CONFLICT,
                    ReopenDecision.Outcome.TERMINAL_OUTPUT_BLOCKED -> {
                        log("Stopping. This state needs operator/backend reconciliation; no new work starts while the journal is unresolved.")
                        return
                    }
                    ReopenDecision.Outcome.RECONCILE_RESULT_PRESENT, ReopenDecision.Outcome.TERMINAL_CLEAR -> {
                        journal.clear()
                        log("Journal cleared. Nothing more to do for that action.")
                        return
                    }
                    ReopenDecision.Outcome.SUBMIT_SAVED_OUTPUT -> {
                        log("Re-submitting the SAME saved output hash; the device reader is NOT run again.")
                        reportSavedOutput(
                            jwt, checkNotNull(state.actionId), resolvedDeviceId, state.idempotencyKey,
                            checkNotNull(decision.savedHash), journal
                        )
                        return
                    }
                    ReopenDecision.Outcome.EXECUTE, ReopenDecision.Outcome.RESUME_POLL -> {
                        val id = checkNotNull(state.actionId)
                        val expected = ActionApprovalVerifier.ExpectedAction(
                            actionId = id, deviceId = state.deviceId, capability = state.capability,
                            riskTier = checkNotNull(state.riskTier), targetDescription = state.targetDescription,
                            createdDigest = checkNotNull(state.createdDigest)
                        )
                        if (decision.outcome == ReopenDecision.Outcome.EXECUTE) {
                            executeApprovedAction(expected, checkNotNull(readback), jwt, resolvedDeviceId, state.idempotencyKey, id, journal)
                            return
                        }
                        Triple(id, state.idempotencyKey, expected)
                    }
                }
            } else {
                log("Creating a battery_status_read action intent...")
                val newIdempotencyKey = "android-${UUID.randomUUID()}"
                val capability = "battery_status_read"
                val targetDescription = "Check battery percent and charging state"
                // CREATE_INTENDED is committed BEFORE the POST. A failed commit
                // throws PhaseWriteException here and no network call is made.
                journal.beginCreate(newIdempotencyKey, resolvedDeviceId, capability, targetDescription)
                val intent = try {
                    api.createIntent(jwt, resolvedDeviceId, capability, targetDescription, newIdempotencyKey)
                } catch (e: AihangoutApiException) {
                    // Clean HTTP refusal: the server definitely did not create
                    // it, so the intent record is safe to drop. An IOException
                    // deliberately propagates with the journal left at
                    // CREATE_INTENDED -> next run decides UNRESOLVED_CREATE.
                    journal.clear()
                    throw e
                }
                val newActionId = intent.getString("actionId")
                val newRiskTier = intent.getString("riskTier")
                val newDigest = intent.getString("actionDigest")
                journal.markCreated(newActionId, newRiskTier, newDigest)
                log("Intent created: actionId=$newActionId. Approve it on the AIHangout web app now.")
                Triple(
                    newActionId, newIdempotencyKey,
                    ActionApprovalVerifier.ExpectedAction(
                        actionId = newActionId, deviceId = resolvedDeviceId, capability = capability,
                        riskTier = newRiskTier, targetDescription = targetDescription, createdDigest = newDigest
                    )
                )
            }

            log("Polling for approval (up to 15 minutes, checking every 5s)...")
            var approvedReadback: JSONObject? = null
            var consecutiveTransientFailures = 0
            val deadline = System.currentTimeMillis() + 15 * 60 * 1000
            while (System.currentTimeMillis() < deadline) {
                // A single flaky poll (a mobile-network blip, a transient 5xx)
                // must not throw away an otherwise-successful 15-minute wait --
                // only a genuine auth failure or an explicit terminal status
                // ends the loop early. Ten consecutive transient failures (50s
                // of total outage) is treated as a real, not transient, problem.
                try {
                    val readback = api.getAction(jwt, actionId)
                    consecutiveTransientFailures = 0
                    val status = readback.getJSONObject("intent").getString("status")
                    if (status == "approved") { approvedReadback = readback; break }
                    if (status == "expired" || status == "denied" || status == "revoked") {
                        log("Action ended with status=$status, stopping.")
                        journal.clear()
                        break
                    }
                } catch (e: AihangoutApiException) {
                    if (e.httpStatus in 401..403 || e.httpStatus == 404) {
                        // Unrecoverable by retrying: the token/action itself is
                        // invalid, not a transient server hiccup.
                        throw e
                    }
                    consecutiveTransientFailures++
                    log("Poll attempt failed with a transient-looking server error (HTTP ${e.httpStatus}), retrying: ${e.message}")
                } catch (e: IOException) {
                    consecutiveTransientFailures++
                    log("Poll attempt failed with a network error, retrying: ${e.message}")
                }
                if (consecutiveTransientFailures >= 10) {
                    throw IOException("Polling for approval failed $consecutiveTransientFailures times in a row -- stopping rather than retrying indefinitely.")
                }
                Thread.sleep(5000)
            }

            if (approvedReadback == null) {
                log("Not approved (timed out or denied). Stopping without executing anything.")
                return
            }

            executeApprovedAction(expectedAction, approvedReadback, jwt, resolvedDeviceId, idempotencyKey, actionId, journal)
        } catch (e: Exception) {
            log("ERROR: ${e.message}")
        } finally {
            mainHandler.post { runButton.isEnabled = true }
        }
    }

    /** Verifies the readback binds to exactly the proposed action (see
     * ActionApprovalVerifier), then executes the effect and reports it.
     * Shared by the normal poll-success path and the restart-reconciliation
     * path so both go through the identical verify-before-execute gate. */
    private fun executeApprovedAction(
        expected: ActionApprovalVerifier.ExpectedAction, approvedReadback: JSONObject,
        jwt: String, resolvedDeviceId: String, idempotencyKey: String, actionId: String, journal: ActionJournal
    ) {
        log("Verifying the approved action matches exactly what this device proposed before executing anything...")
        ActionApprovalVerifier.verifyApprovedForExecution(expected, approvedReadback)

        // EFFECT_INTENDED is committed BEFORE the reader runs: a crash from
        // here on reopens as QUARANTINE_EFFECT_UNKNOWN, never as a second read.
        journal.markEffectIntended()
        log("Verified. Reading battery status...")
        val reader = AndroidDeviceReader(this)
        val battery = reader.readBatteryStatus()
        val contentJson = ResultHasher.batteryStatusJson(battery)
        val hash = ResultHasher.hashStructuredResult(
            capability = "battery_status_read", actionId = actionId, deviceId = resolvedDeviceId,
            redactionPolicy = ResultHasher.REDACTION_POLICY_STRUCTURED_FIELDS_V1, contentJson = contentJson
        )
        log("Read: percent=${battery.percent} charging=${battery.isCharging}. Reporting only the hash, never the raw reading, to the backend.")

        // OUTPUT_RECORDED (the exact hash to be sent) is committed BEFORE the
        // report POST, so a lost response can only ever re-submit this hash.
        journal.recordOutput(hash)
        reportSavedOutput(jwt, actionId, resolvedDeviceId, idempotencyKey, hash, journal)
    }

    /** Reports an already-journaled output hash. Shared by the normal path
     * and the SUBMIT_SAVED_OUTPUT reopen path, which re-submits the SAME
     * saved hash without touching the device reader. */
    private fun reportSavedOutput(
        jwt: String, actionId: String, resolvedDeviceId: String, idempotencyKey: String, hash: String, journal: ActionJournal
    ) {
        try {
            api.reportResult(jwt, actionId, resolvedDeviceId, idempotencyKey, "executed", hash)
        } catch (e: IOException) {
            // Ambiguous: the server may have recorded the result even though
            // this device never saw its response. The journal stays at
            // OUTPUT_RECORDED; the next run reads the action back and only
            // re-submits this same hash if the server holds no result.
            log("Result report outcome is UNKNOWN (network error): ${e.message}. Journal left at OUTPUT_RECORDED; will reconcile via GET on the next run rather than retry blindly now.")
            return
        }

        journal.markReported()
        log("Result reported. Reading back final state...")
        val finalState = api.getAction(jwt, actionId)
        val decision = journal.decide(checkNotNull(journal.load()), finalState)
        check(decision.outcome == ReopenDecision.Outcome.RECONCILE_RESULT_PRESENT) { decision.reason }
        val summary = "Action $actionId: ${renderFinalState(finalState)}"
        tokenStore.lastResult = summary
        journal.clear()
        log(summary)
    }
}
