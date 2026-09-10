package com.aihangout.companion.data

import org.json.JSONObject

/**
 * Classifies what the backend said about an assistance request
 * (A5-frontier-phone-wiring-20260910.md): 424 carries `status: unknown|failed`
 * (provider timeout vs definitive provider/model failure), 409 on resubmit
 * carries the stored status (`pending|unknown|failed`), and the GET readback
 * carries the stored outcome. ONLY an authoritative `failed` permits a new
 * requestId; `pending`/`unknown` keep the same id and forbid a second POST.
 */
object AssistanceOutcome {
    sealed class Kind {
        data class SetupRequired(val serverStatus: String) : Kind()
        /** A stored answer exists (diagnosis present) -- consume it, do not POST again. */
        data class Answered(val body: JSONObject) : Kind()
        /** Provider outcome not known yet or not knowable: same requestId, no new POST, no new id. */
        data class Unknown(val serverStatus: String) : Kind()
        /** Authoritative failure: evidence kept; an explicit human retry may mint a NEW id. */
        data class Failed(val serverStatus: String, val detail: String) : Kind()
    }

    private val UNKNOWN_STATUSES = setOf("pending", "unknown")

    /** For a 4xx from the POST. */
    fun fromError(httpStatus: Int, body: JSONObject?, message: String): Kind {
        val status = body?.optString("status", "") ?: ""
        return when {
            httpStatus == 424 && status in setOf("disabled", "not_configured") -> Kind.SetupRequired(status)
            (httpStatus == 424 || httpStatus == 409) && status in UNKNOWN_STATUSES -> Kind.Unknown(status)
            (httpStatus == 424 || httpStatus == 409) && status == "failed" -> Kind.Failed(status, message)
            httpStatus == 409 && body?.has("diagnosis") == true && !body.isNull("diagnosis") -> Kind.Answered(body)
            httpStatus == 424 || httpStatus == 409 -> Kind.Unknown(status.ifEmpty { "unspecified" }) // never guess "failed"
            else -> Kind.Failed("http_$httpStatus", message)
        }
    }

    /** For the GET readback body (null = server never saw the id, so a POST with the SAME id is safe). */
    fun fromReadback(body: JSONObject?): Kind? {
        if (body == null) return null
        val status = body.optString("status", "")
        return when {
            status in UNKNOWN_STATUSES -> Kind.Unknown(status)
            status == "failed" -> Kind.Failed(status, body.optString("error", "stored outcome failed"))
            body.has("diagnosis") && !body.isNull("diagnosis") -> Kind.Answered(body)
            else -> Kind.Unknown(status.ifEmpty { "unspecified" })
        }
    }
}
