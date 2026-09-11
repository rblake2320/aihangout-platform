package com.aihangout.companion

import com.aihangout.companion.diagnostics.NetworkClassifier
import com.aihangout.companion.diagnostics.NetworkObservation
import com.aihangout.companion.diagnostics.NetworkReport
import com.aihangout.companion.diagnostics.NetworkVerdict.Category
import com.aihangout.companion.diagnostics.ProbeClassifier
import com.aihangout.companion.diagnostics.ProbeResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException

class NetworkDiagnosticsTest {
    private val ep = "https://example.test/api/health"
    private fun obs(active: Boolean = true, transport: String = "wifi", internet: Boolean? = true, validated: Boolean? = true,
                    captive: Boolean? = false, metered: Boolean? = false, probe: ProbeResult = ProbeResult.Ok(200, 42)) =
        NetworkObservation(active, transport, internet, validated, captive, metered, ep, probe)

    @Test
    fun `offline -- no active network`() {
        val v = NetworkClassifier.classify(obs(active = false, transport = "none", internet = null, validated = null, captive = null, metered = null, probe = ProbeResult.NotAttempted("no active network")))
        assertEquals(Category.OFFLINE, v.category)
    }

    @Test
    fun `unknown -- network present but Android gave no capabilities`() {
        val v = NetworkClassifier.classify(obs(transport = "unknown", internet = null, validated = null, captive = null, metered = null, probe = ProbeResult.NotAttempted("probe disabled")))
        assertEquals(Category.UNKNOWN, v.category)
    }

    @Test
    fun `captive portal wins over everything else`() {
        val v = NetworkClassifier.classify(obs(validated = false, captive = true, probe = ProbeResult.Failed(ProbeResult.Failed.Kind.TIMEOUT, "t", 5000)))
        assertEquals(Category.CAPTIVE_PORTAL, v.category)
        assertTrue(v.explanation.contains("portal"))
    }

    @Test
    fun `validated but backend probe failed -- each failure kind gets its own honest explanation`() {
        for (k in ProbeResult.Failed.Kind.values()) {
            val v = NetworkClassifier.classify(obs(probe = ProbeResult.Failed(k, "HTTP 503", 120)))
            assertEquals(Category.BACKEND_UNREACHABLE, v.category)
            assertTrue(k.name, v.explanation.isNotBlank())
        }
        assertTrue(NetworkClassifier.classify(obs(probe = ProbeResult.Failed(ProbeResult.Failed.Kind.DNS, "x", 1))).explanation.contains("DNS"))
    }

    @Test
    fun `validated and probe ok -- backend reachable with status and latency stated`() {
        val v = NetworkClassifier.classify(obs())
        assertEquals(Category.BACKEND_REACHABLE, v.category)
        assertTrue(v.explanation.contains("HTTP 200") && v.explanation.contains("42 ms"))
    }

    @Test
    fun `connected but unvalidated -- reported as such, probe result only annotates`() {
        assertEquals(Category.CONNECTED_UNVALIDATED, NetworkClassifier.classify(obs(validated = false)).category)
        assertEquals(Category.CONNECTED_UNVALIDATED, NetworkClassifier.classify(obs(validated = false, probe = ProbeResult.NotAttempted("x"))).category)
    }

    @Test
    fun `classification is deterministic and labeled rule-based, never as model output`() {
        val a = NetworkClassifier.classify(obs()); val b = NetworkClassifier.classify(obs())
        assertEquals(a, b)
        assertTrue(a.source.contains("deterministic"))
        assertTrue(a.source.contains("not a model output"))
        assertTrue(a.toJson().getString("source").contains("not a model output"))
    }

    @Test
    fun `probe exceptions map to stable kinds`() {
        assertEquals(ProbeResult.Failed.Kind.TIMEOUT, ProbeClassifier.fromThrowable(SocketTimeoutException("t"), 5000).kind)
        assertEquals(ProbeResult.Failed.Kind.DNS, ProbeClassifier.fromThrowable(UnknownHostException("h"), 1).kind)
        assertEquals(ProbeResult.Failed.Kind.TLS, ProbeClassifier.fromThrowable(SSLHandshakeException("s"), 1).kind)
        assertEquals(ProbeResult.Failed.Kind.CONNECT, ProbeClassifier.fromThrowable(ConnectException("c"), 1).kind)
        assertEquals(ProbeResult.Failed.Kind.OTHER, ProbeClassifier.fromThrowable(IllegalStateException("?"), 1).kind)
        assertTrue(ProbeClassifier.fromThrowable(IllegalStateException("x".repeat(500)), 1).detail.length < 200)
    }

    @Test
    fun `the private report carries schema, observation, verdict and privacy note, and no network identity fields`() {
        val r = NetworkReport.build(obs(), NetworkClassifier.classify(obs()), "2026-09-10T23:59:00Z", "0.1.0")
        assertEquals(1, r.getInt("schemaVersion"))
        assertEquals("BACKEND_REACHABLE", r.getJSONObject("verdict").getString("category"))
        assertTrue(r.getString("privacy").contains("no automatic upload"))
        // Identity fields must be absent from the DATA (observation + verdict); the privacy
        // sentence is prose and is checked separately above.
        val data = (r.getJSONObject("observation").toString() + r.getJSONObject("verdict").toString()).lowercase()
        for (forbidden in listOf("ssid", "bssid", "latitude", "longitude", "\"ip\"", "token", "jwt", "deviceid", "owner")) assertFalse(forbidden, data.contains(forbidden))
    }

    @Test
    fun `the share text is minimal -- verdict and observation only, no endpoint URL, token, account, device or network identity`() {
        val o = obs(); val v = NetworkClassifier.classify(o)
        val t = NetworkReport.shareText(o, v, "2026-09-10T23:59:00Z")
        assertTrue(t.contains("Verdict: BACKEND_REACHABLE"))
        assertTrue(t.contains("shared by the user"))
        assertTrue(t.contains("not a model output"))
        assertTrue(t.contains("transport=wifi") && t.contains("validated=true"))
        val low = t.lowercase()
        for (forbidden in listOf("example.test", "https://", "token", "jwt", "deviceid", "device-", "owner", "ssid", "bssid", "@")) assertFalse(forbidden, low.contains(forbidden))
        assertTrue(t.length < 1200)
    }
}
