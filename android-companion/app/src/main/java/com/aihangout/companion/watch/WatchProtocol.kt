package com.aihangout.companion.watch

import org.json.JSONObject

data class WatchAnalysis(val summary: String, val proposalText: String?)

/** Remote text is evidence/advice, never a command or permission. */
object WatchProtocol {
    const val BLINK = "com.immediasemi.android.blink"
    const val BLINK_SOURCE = "blink_notification"
    const val CHECKIN = "show_local_checkin"
    const val CHECKIN_TEXT = "Please check the camera view."
    fun acceptsPackage(value: String) = value == BLINK
    fun acceptsMotion(packageName: String, title: String, text: String, posted: Long, now: Long): Boolean =
        acceptsPackage(packageName) && posted > 0 && now-posted in -30000..600000 &&
            Regex("\\bmotion\\b",RegexOption.IGNORE_CASE).containsMatchIn("$title $text")
    fun parse(raw: String, requestId: String, eventId: String): WatchAnalysis {
        require(raw.length <= 131072) { "Oversized analysis response" }
        val obj = JSONObject(raw)
        require(obj.opt("success") == true) { "Analysis not successful" }
        require(obj.opt("requestId") == requestId && obj.opt("eventId") == eventId) { "Response identity mismatch" }
        require(obj.opt("status") == "analyzed") { "Analysis not complete" }
        val summary = obj.opt("summary")
        require(summary is String && summary.isNotBlank() && summary.length <= 4000) { "Invalid summary" }
        val value = obj.opt("proposal")
        if (value == null || value == JSONObject.NULL) return WatchAnalysis(summary, null)
        require(value is JSONObject && value.opt("operation") == CHECKIN && value.opt("text") == CHECKIN_TEXT) { "Unsupported proposal" }
        return WatchAnalysis(summary, CHECKIN_TEXT)
    }
    /** GET-only reconciliation includes unsuccessful but terminal, identity-bound records. */
    fun reconciledState(raw: String, requestId: String, eventId: String): String {
        require(raw.length<=131072)
        val obj=JSONObject(raw)
        require(obj.opt("requestId")==requestId && obj.opt("eventId")==eventId) { "Response identity mismatch" }
        return when(obj.opt("status")) {
            "analyzed" -> { parse(raw,requestId,eventId); "ANALYZED" }
            "failed" -> { require(obj.opt("success")==false); "FAILED" }
            "pending", "unknown" -> { require(obj.opt("success")==false); "UNKNOWN" }
            else -> error("Unknown analysis state")
        }
    }
}
