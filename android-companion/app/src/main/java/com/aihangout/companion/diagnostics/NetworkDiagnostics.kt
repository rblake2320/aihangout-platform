package com.aihangout.companion.diagnostics

import org.json.JSONObject

/**
 * Read-only network diagnostics (Team/tasks/A3-remaining-phone-assignment-20260910.md).
 * Everything here is a pure description of what was OBSERVED plus a
 * deterministic, rule-based explanation. Nothing scans, mutates a router,
 * or collects SSID/BSSID/location; the only network activity is one bounded
 * HTTPS probe to the app's fixed backend health endpoint.
 */

/** Outcome of the single bounded reachability probe. */
sealed class ProbeResult {
    data class NotAttempted(val reason: String) : ProbeResult()
    data class Ok(val httpStatus: Int, val latencyMs: Long) : ProbeResult()
    data class Failed(val kind: Kind, val detail: String, val latencyMs: Long) : ProbeResult() {
        enum class Kind { TIMEOUT, DNS, TLS, CONNECT, HTTP_ERROR, OTHER }
    }

    fun toJson(): JSONObject = when (this) {
        is NotAttempted -> JSONObject().put("outcome", "not_attempted").put("reason", reason)
        is Ok -> JSONObject().put("outcome", "ok").put("httpStatus", httpStatus).put("latencyMs", latencyMs)
        is Failed -> JSONObject().put("outcome", "failed").put("kind", kind.name).put("detail", detail).put("latencyMs", latencyMs)
    }
}

/** Structured, PII-free observation. Booleans are nullable because the
 * framework can genuinely not know (no active network, null capabilities). */
data class NetworkObservation(
    val hasActiveNetwork: Boolean,
    val transport: String,            // wifi | cellular | ethernet | vpn | other | none | unknown
    val hasInternetCapability: Boolean?,
    val validated: Boolean?,          // NET_CAPABILITY_VALIDATED (API 23+)
    val captivePortal: Boolean?,      // NET_CAPABILITY_CAPTIVE_PORTAL (API 23+)
    val metered: Boolean?,
    val probeEndpoint: String,        // fixed; never user- or model-supplied
    val probe: ProbeResult
) {
    fun toJson(): JSONObject = JSONObject()
        .put("hasActiveNetwork", hasActiveNetwork).put("transport", transport)
        .put("hasInternetCapability", hasInternetCapability ?: JSONObject.NULL)
        .put("validated", validated ?: JSONObject.NULL)
        .put("captivePortal", captivePortal ?: JSONObject.NULL)
        .put("metered", metered ?: JSONObject.NULL)
        .put("probeEndpoint", probeEndpoint).put("probe", probe.toJson())
}

data class NetworkVerdict(val category: Category, val explanation: String) {
    enum class Category { OFFLINE, CAPTIVE_PORTAL, CONNECTED_UNVALIDATED, BACKEND_UNREACHABLE, BACKEND_REACHABLE, UNKNOWN }

    /** Always stated explicitly so the text is never mistaken for a model's opinion. */
    val source: String get() = "rule-based classifier (deterministic); not a model output"

    fun toJson(): JSONObject = JSONObject().put("category", category.name).put("explanation", explanation).put("source", source)
}

/** Pure, deterministic: same observation in, same verdict and same words out. */
object NetworkClassifier {
    fun classify(o: NetworkObservation): NetworkVerdict {
        if (!o.hasActiveNetwork) {
            return NetworkVerdict(NetworkVerdict.Category.OFFLINE, "No active network: the device reports no default network, so nothing can be reached.")
        }
        if (o.captivePortal == true) {
            return NetworkVerdict(NetworkVerdict.Category.CAPTIVE_PORTAL, "A captive portal is intercepting traffic on the ${o.transport} network: sign in to the network's portal page (a browser) before the app can reach anything.")
        }
        if (o.validated == null && o.hasInternetCapability == null) {
            return NetworkVerdict(NetworkVerdict.Category.UNKNOWN, "A network is active but Android returned no capability details for it; the state cannot be classified from what was observed.")
        }
        if (o.validated == false) {
            val probeNote = when (val p = o.probe) {
                is ProbeResult.Ok -> " The backend probe nevertheless answered HTTP ${p.httpStatus}, so the validation flag may simply be pending."
                is ProbeResult.Failed -> " The backend probe also failed (${p.kind}), consistent with no working internet path."
                is ProbeResult.NotAttempted -> ""
            }
            return NetworkVerdict(NetworkVerdict.Category.CONNECTED_UNVALIDATED, "Connected to a ${o.transport} network that Android has not validated as having internet access.$probeNote")
        }
        return when (val p = o.probe) {
            is ProbeResult.Ok -> NetworkVerdict(NetworkVerdict.Category.BACKEND_REACHABLE, "Internet is validated on ${o.transport} and the fixed backend health endpoint answered HTTP ${p.httpStatus} in ${p.latencyMs} ms.")
            is ProbeResult.Failed -> NetworkVerdict(NetworkVerdict.Category.BACKEND_UNREACHABLE, "Internet is validated on ${o.transport} but the fixed backend health endpoint could not be reached: ${describe(p)}.")
            is ProbeResult.NotAttempted -> NetworkVerdict(NetworkVerdict.Category.UNKNOWN, "Internet is validated on ${o.transport}; the backend probe was not attempted (${p.reason}), so backend reachability is unknown.")
        }
    }

    private fun describe(p: ProbeResult.Failed): String = when (p.kind) {
        ProbeResult.Failed.Kind.TIMEOUT -> "no answer within the time limit (${p.latencyMs} ms) -- the backend or the path to it is down or very slow"
        ProbeResult.Failed.Kind.DNS -> "the backend hostname did not resolve -- DNS on this network is failing or the name is wrong"
        ProbeResult.Failed.Kind.TLS -> "the TLS handshake failed -- an interception proxy, a wrong clock, or a certificate problem"
        ProbeResult.Failed.Kind.CONNECT -> "the connection was refused or reset -- the backend process is not listening"
        ProbeResult.Failed.Kind.HTTP_ERROR -> "the endpoint answered with an error status (${p.detail})"
        ProbeResult.Failed.Kind.OTHER -> "an unclassified error (${p.detail})"
    }
}

/** Maps a probe exception to a stable kind. Pure; JVM-tested. */
object ProbeClassifier {
    fun fromThrowable(t: Throwable, latencyMs: Long): ProbeResult.Failed {
        val kind = when (t) {
            is java.net.SocketTimeoutException -> ProbeResult.Failed.Kind.TIMEOUT
            is java.net.UnknownHostException -> ProbeResult.Failed.Kind.DNS
            is javax.net.ssl.SSLException -> ProbeResult.Failed.Kind.TLS
            is java.net.ConnectException -> ProbeResult.Failed.Kind.CONNECT
            else -> ProbeResult.Failed.Kind.OTHER
        }
        return ProbeResult.Failed(kind, "${t.javaClass.simpleName}: ${(t.message ?: "").take(160)}", latencyMs)
    }
}

/** Timestamped private report; never uploaded by this feature. */
object NetworkReport {
    const val SCHEMA_VERSION = 1
    fun build(observation: NetworkObservation, verdict: NetworkVerdict, capturedAtIso: String, appVersion: String): JSONObject =
        JSONObject().put("schemaVersion", SCHEMA_VERSION).put("capturedAt", capturedAtIso).put("appVersion", appVersion)
            .put("observation", observation.toJson()).put("verdict", verdict.toJson())
            .put("privacy", "no network identity, location or address collected; stored app-private; no automatic upload")

    /**
     * Minimal plain text for a deliberate, human-initiated ACTION_SEND hand-off
     * (e.g. to an LLM app the owner chooses). Built only from the observation
     * and the rule-based verdict: no account, token, device id, endpoint URL,
     * or network identity. The text says plainly that it is a user hand-off,
     * not an interpretation the app produced.
     */
    fun shareText(observation: NetworkObservation, verdict: NetworkVerdict, capturedAtIso: String): String {
        val probe = when (val p = observation.probe) {
            is ProbeResult.Ok -> "ok (HTTP ${p.httpStatus}, ${p.latencyMs} ms)"
            is ProbeResult.Failed -> "failed (${p.kind}, ${p.latencyMs} ms)"
            is ProbeResult.NotAttempted -> "not attempted (${p.reason})"
        }
        return """
            AIHangout companion -- read-only network diagnostic (shared by the user, $capturedAtIso)
            Verdict: ${verdict.category}
            ${verdict.explanation}
            Source: ${verdict.source}
            Observed: transport=${observation.transport}, internetCapability=${observation.hasInternetCapability}, validated=${observation.validated}, captivePortal=${observation.captivePortal}, metered=${observation.metered}
            Backend health probe (fixed endpoint, one bounded HTTPS GET): $probe
            This text was composed by fixed rules on the phone and handed to the app you picked; it carries no credentials, no identifiers and no network names.
        """.trimIndent()
    }
}
