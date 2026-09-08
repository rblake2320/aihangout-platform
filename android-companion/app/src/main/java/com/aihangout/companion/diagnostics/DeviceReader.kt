package com.aihangout.companion.diagnostics

/** Structured, already-minimized diagnostic facts -- no PII, per the
 * redaction-pipeline design's rule that this tier needs no content
 * scrubbing beyond not retaining a raw history. */
data class BatteryStatus(val percent: Int, val isCharging: Boolean)

/** SSID/BSSID are deliberately never included here, per the redaction
 * design: network identity strings are stripped to a category before
 * this object is ever constructed. */
data class NetworkStatus(val connectionType: String, val isMetered: Boolean)

/**
 * Isolates the real Android framework calls (BatteryManager,
 * ConnectivityManager) behind an interface so the logic that CONSUMES
 * their output -- JSON construction, hashing, the enroll/intent/approve/
 * result state machine -- is unit-testable on a plain JVM with a fake,
 * per the QA-plan design's recommendation. Only the real implementation
 * (AndroidDeviceReader, not included in JVM unit tests) touches the
 * actual framework classes.
 */
interface DeviceReader {
    fun readBatteryStatus(): BatteryStatus
    fun readNetworkStatus(): NetworkStatus
}
