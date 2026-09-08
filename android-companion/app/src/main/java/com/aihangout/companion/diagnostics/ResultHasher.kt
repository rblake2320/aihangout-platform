package com.aihangout.companion.diagnostics

import org.json.JSONObject
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Implements the redaction-pipeline design's hash format: a canonical
 * JSON wrapper around the actual content hash, never the raw content
 * itself, reported to the backend as resultPayloadHash. For this
 * milestone's capabilities (battery/network status), the "redaction
 * policy" is simply: do not retain history, hash the single reading and
 * discard it -- named explicitly via redactionPolicy so a future reader
 * always knows exactly what did (and did not) run, per the design's
 * explicit-honesty requirement.
 */
object ResultHasher {
    const val REDACTION_POLICY_STRUCTURED_FIELDS_V1 = "struct-fields-only-v1"

    fun hashStructuredResult(
        capability: String,
        actionId: String,
        deviceId: String,
        redactionPolicy: String,
        contentJson: String
    ): String {
        val rawSha256 = sha256Hex(contentJson)
        val wrapper = JSONObject()
            .put("v", 1)
            .put("capability", capability)
            .put("actionId", actionId)
            .put("deviceId", deviceId)
            .put("redactionPolicy", redactionPolicy)
            .put("contentByteLength", contentJson.toByteArray(Charsets.UTF_8).size)
            .put("capturedAt", isoNow())
            .put("rawSha256", rawSha256)
        // JSONObject does not guarantee key order across platforms, but
        // this hash is this app's own internal record (never independently
        // recomputed/verified server-side against a canonical form -- the
        // backend only ever sees the final hash string) so ordering
        // stability is not a correctness requirement here, unlike
        // ActionDigest's server-parity requirement.
        return sha256Hex(wrapper.toString())
    }

    fun batteryStatusJson(status: BatteryStatus): String =
        JSONObject().put("percent", status.percent).put("isCharging", status.isCharging).toString()

    fun networkStatusJson(status: NetworkStatus): String =
        JSONObject().put("connectionType", status.connectionType).put("isMetered", status.isMetered).toString()

    private fun sha256Hex(s: String): String {
        val bytes = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
        return "sha256:" + bytes.joinToString("") { "%02x".format(it) }
    }

    private fun isoNow(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        fmt.timeZone = TimeZone.getTimeZone("UTC")
        return fmt.format(Date())
    }
}
