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
import com.aihangout.companion.data.JournalState
import com.aihangout.companion.data.Phase
import com.aihangout.companion.data.RecoveryResolver
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
        val archiveButton = Button(this).apply { text = "Archive unresolved journal/lock (preserve evidence)" }
        statusView = TextView(this).apply { text = statusLog.append(tokenStore.lastResult ?: "Idle.") }

        runButton.setOnClickListener {
            val email = emailInput.text.toString()
            val password = passwordInput.text.toString()
            val agentName = agentNameInput.text.toString()
            runButton.isEnabled = false
            Thread { runFlow(email, password, agentName, runButton) }.start()
        }
        archiveButton.setOnClickListener {
            archiveButton.isEnabled = false
            Thread { archiveUnresolved(archiveButton) }.start()
        }

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
            addView(emailInput)
            addView(passwordInput)
            addView(agentNameInput)
            addView(runButton)
            addView(archiveButton)
            addView(statusView)
        }
        setContentView(ScrollView(this).apply { addView(layout) })
    }

    /** Bounded panel model; mutated only on the main thread via [mainHandler]. */
    private val statusLog = StatusLog()

    private fun log(line: String) {
        mainHandler.post { statusView.text = statusLog.append(line) }
    }

    private fun markConnected() {
        mainHandler.post { statusView.text = statusLog.markConnected(BuildConfig.AIHANGOUT_BASE_URL) }
    }

    private fun markDisconnected(e: Throwable) {
        val detail = "${e.javaClass.simpleName}: ${e.message ?: ""}"
        mainHandler.post { statusView.text = statusLog.markDisconnected(BuildConfig.AIHANGOUT_BASE_URL, detail) }
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
            if (e.httpStatus == 409) {
                // The single most likely cause is that a PRIOR attempt committed
                // and its response was lost. Resolve it by identity-bound lookup
                // (Team/tasks/A1-to-A3-phone-final-recovery-20260910.md), never by
                // guessing or by retrying under a new name.
                log("Enrollment returned 409 (agent name already enrolled). Reconciling via identity-bound lookup...")
                when (val r = RecoveryResolver.resolveEnrollment(agentName, spki, api.lookupDevice(jwt, agentName))) {
                    is RecoveryResolver.EnrollmentResolution.Adopt -> {
                        journal.archiveEnrollmentLock("409 then lookup: this device's key is already enrolled as ${r.deviceId}")
                        log("A prior enrollment had committed: adopted deviceId=${r.deviceId}.")
                        return r.deviceId
                    }
                    is RecoveryResolver.EnrollmentResolution.KeyConflict -> {
                        journal.archiveEnrollmentLock("409: agent name held by a different key (device ${r.deviceId})")
                        throw IllegalStateException("Agent name '$agentName' is held by ANOTHER device (${r.deviceId}, key fingerprint ${r.existingKeyFingerprint.take(16)}…). Revoke it on the web app or choose a new agent name.")
                    }
                    is RecoveryResolver.EnrollmentResolution.Revoked -> {
                        journal.archiveEnrollmentLock("409: own key enrolled as ${r.deviceId} but revoked")
                        throw IllegalStateException("This device's key was enrolled as ${r.deviceId} but is REVOKED; the agent name cannot be reused -- choose a new agent name.")
                    }
                    RecoveryResolver.EnrollmentResolution.NotCommitted -> {
                        // 409 for another reason (e.g. a consumed challenge): definitive, nothing committed.
                        journal.clearEnrollmentUnknown()
                        throw e
                    }
                }
            }
            journal.clearEnrollmentUnknown()
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

    /**
     * A create POST whose response was lost leaves the journal at
     * CREATE_INTENDED. Resolve it by the identity the journal already holds
     * (owner-scoped lookup on the device + idempotency key), never by
     * replaying the POST:
     *  - authoritative miss  -> archive the journal (evidence kept) and return
     *    null so the normal path starts a fresh create;
     *  - identity-bound hit  -> adopt the server's actionId/tier/digest
     *    (journal moves to CREATED) and return the updated journal;
     *  - mismatch            -> leave the journal untouched; the caller's
     *    decide() then stops on UNRESOLVED_CREATE for the operator.
     * Any ambiguous lookup outcome propagates, journal untouched.
     */
    private fun reconcileUnresolvedCreate(jwt: String, state: JournalState, journal: ActionJournal): JournalState? {
        log("Create outcome unresolved (idempotencyKey=${state.idempotencyKey}). Reconciling via identity-bound lookup (no replay)...")
        return when (val r = RecoveryResolver.resolveCreate(state, api.lookupAction(jwt, state.deviceId, state.idempotencyKey))) {
            RecoveryResolver.CreateResolution.NotCommitted -> {
                journal.archive("lookup: no action under this device/key; create never committed")
                log("Create had NOT committed (authoritative lookup miss). Journal archived; starting a fresh create.")
                null
            }
            is RecoveryResolver.CreateResolution.Adopt -> {
                journal.markCreated(r.actionId, r.riskTier, r.createdDigest)
                log("Create HAD committed: adopted actionId=${r.actionId} (identity and digest verified).")
                checkNotNull(journal.load())
            }
            is RecoveryResolver.CreateResolution.IdentityMismatch -> {
                log("MISMATCH: the server holds an action under this key that is NOT what this device intended (${r.reason}). " +
                    "Journal preserved for the operator; tap 'Archive unresolved' after reviewing it on the web app.")
                state
            }
        }
    }

    /**
     * Operator resolution for a journal or lock the automatic reconciliation
     * refuses to clear (unknown effect, conflicting result, terminal-blocked
     * output, foreign journal, identity mismatch, key conflict). Never re-runs
     * an effect and never deletes evidence: an EFFECT_INTENDED journal is first
     * reported to the server as `failed` (the effect's outcome is unknown), and
     * everything is then MOVED to the append-only history. An ambiguous report
     * outcome leaves the journal in place for another attempt.
     */
    private fun archiveUnresolved(archiveButton: Button) {
        try {
            // archive()/lock operations are session-independent; only decide()
            // binds to owner/baseUrl, and it is not used here.
            val journal = ActionJournal(tokenStore.phaseStore, "operator", BuildConfig.AIHANGOUT_BASE_URL)
            val state = journal.load()
            if (state == null && !journal.enrollmentUnknown()) {
                log("Nothing to archive: no action journal and no enrollment lock.")
                return
            }
            if (state != null) {
                if (state.phase == Phase.EFFECT_INTENDED && state.actionId != null) {
                    val jwt = tokenStore.jwt
                    if (jwt == null) {
                        log("Cannot report the unknown effect without a session token -- log in (tap Run) first, then archive.")
                        return
                    }
                    log("Reporting actionId=${state.actionId} as FAILED (effect outcome unknown) before archiving; the device reader is NOT run again.")
                    try {
                        api.reportResult(jwt, state.actionId, state.deviceId, state.idempotencyKey, "failed", null)
                    } catch (e: AihangoutApiException) {
                        // Definitive server decision (e.g. the action is terminal or already holds a result): server state wins.
                        log("Server refused the failed-result report (HTTP ${e.httpStatus}: ${e.message}); server state is authoritative, archiving anyway.")
                    }
                }
                journal.archive("operator archive from phase ${state.phase} (actionId=${state.actionId ?: "none"})")
                log("Action journal archived to history (${journal.history().size} entries); active journal cleared.")
            }
            if (journal.enrollmentUnknown()) {
                journal.archiveEnrollmentLock("operator archive")
                log("Enrollment lock archived to history (${journal.enrollmentHistory().size} entries); lock cleared.")
            }
        } catch (e: Exception) {
            log("ARCHIVE NOT DONE (evidence left in place): ${e.message}")
        } finally {
            mainHandler.post { archiveButton.isEnabled = true }
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
            markConnected()
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
            if (deviceId == null && journal.enrollmentUnknown()) {
                // A previous enroll POST's outcome was never confirmed. Ask the
                // backend by the identity the lock recorded (never the text field,
                // never a replay) and bind the answer to THIS device's key.
                val lock = checkNotNull(journal.enrollmentLock())
                val lockedAgent = lock.optString("agentName", agentName)
                log("Enrollment outcome unresolved for agent '$lockedAgent'. Reconciling via identity-bound lookup (no replay)...")
                when (val r = RecoveryResolver.resolveEnrollment(lockedAgent, spki, api.lookupDevice(jwt, lockedAgent))) {
                    is RecoveryResolver.EnrollmentResolution.Adopt -> {
                        tokenStore.deviceId = r.deviceId
                        deviceId = r.deviceId
                        journal.archiveEnrollmentLock("lookup: enrollment had committed as ${r.deviceId}; adopted")
                        log("Enrollment HAD committed: adopted deviceId=${r.deviceId}.")
                    }
                    RecoveryResolver.EnrollmentResolution.NotCommitted -> {
                        journal.archiveEnrollmentLock("lookup: no device under '$lockedAgent'; enrollment never committed")
                        log("Enrollment had NOT committed (authoritative lookup miss). Enrolling now.")
                    }
                    is RecoveryResolver.EnrollmentResolution.KeyConflict -> {
                        log("CONFLICT: agent name '$lockedAgent' is held by device ${r.deviceId} with a DIFFERENT key " +
                            "(fingerprint ${r.existingKeyFingerprint.take(16)}…). Not adopting. Operator: revoke that device " +
                            "on the web app or use a new agent name, then tap 'Archive unresolved' to clear this lock.")
                        return
                    }
                    is RecoveryResolver.EnrollmentResolution.Revoked -> {
                        log("This device's key is enrolled as ${r.deviceId} but REVOKED; the agent name cannot be reused. " +
                            "Operator: choose a new agent name, then tap 'Archive unresolved' to clear this lock.")
                        return
                    }
                }
            }
            if (deviceId == null) {
                deviceId = enrollDevice(jwt, loginResult.userId, agentName, spki, packageName, certSha256, journal)
                tokenStore.deviceId = deviceId
                if (journal.enrollmentUnknown()) journal.clearEnrollmentUnknown()
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
            var state = journal.load()
            if (state != null && journal.belongsToCurrentSession(state) && state.phase == Phase.CREATE_INTENDED) {
                state = reconcileUnresolvedCreate(jwt, state, journal)
            }
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
        } catch (e: IOException) {
            // Truthful, bounded outage reporting: one counted connection line
            // instead of a raw exception appended on every tap.
            markDisconnected(e)
            log("DISCONNECTED: the backend did not respond. Any write-ahead journal or enrollment lock above is intact; tap Run again once the backend is reachable to reconcile (no blind replay).")
        } catch (e: com.aihangout.companion.net.ResponseIntegrityException) {
            log("OUTCOME UNKNOWN: ${e.message}. Journal/lock preserved; the next run reconciles by lookup.")
        } catch (e: AihangoutApiException) {
            log("REFUSED by server (HTTP ${e.httpStatus}): ${e.message}")
        } catch (e: Exception) {
            log("ERROR (${e.javaClass.simpleName}): ${e.message}")
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
