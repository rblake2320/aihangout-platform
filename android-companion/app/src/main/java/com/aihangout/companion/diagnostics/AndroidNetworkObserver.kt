package com.aihangout.companion.diagnostics

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * Real framework side of the read-only diagnostics (not JVM-tested; the
 * classifier/report it feeds is). Reads the active network's capabilities
 * with ACCESS_NETWORK_STATE only, and makes ONE bounded GET to the fixed
 * backend health endpoint: 5 s connect/read timeouts, no redirects
 * followed, response body closed unread. Nothing else on the network.
 */
class AndroidNetworkObserver(private val context: Context, private val baseUrl: String) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS).callTimeout(8, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false)
        .build()

    fun observe(runProbe: Boolean = true): NetworkObservation {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork
        val caps = network?.let { cm.getNetworkCapabilities(it) }
        val endpoint = "$baseUrl/api/health"
        val transport = when {
            network == null -> "none"
            caps == null -> "unknown"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
        val probe: ProbeResult = when {
            network == null -> ProbeResult.NotAttempted("no active network")
            !runProbe -> ProbeResult.NotAttempted("probe disabled")
            else -> probe(endpoint)
        }
        return NetworkObservation(
            hasActiveNetwork = network != null,
            transport = transport,
            hasInternetCapability = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
            validated = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
            captivePortal = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL),
            metered = caps?.let { !it.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) },
            probeEndpoint = endpoint,
            probe = probe
        )
    }

    private fun probe(endpoint: String): ProbeResult {
        val start = System.nanoTime()
        fun elapsed() = (System.nanoTime() - start) / 1_000_000
        return try {
            client.newCall(Request.Builder().url(endpoint).get().build()).execute().use { resp ->
                if (resp.code in 200..399) ProbeResult.Ok(resp.code, elapsed())
                else ProbeResult.Failed(ProbeResult.Failed.Kind.HTTP_ERROR, "HTTP ${resp.code}", elapsed())
            }
        } catch (t: Exception) {
            ProbeClassifier.fromThrowable(t, elapsed())
        }
    }

    /** App-private, timestamped, bounded to the newest [keep] files; never uploaded. */
    fun saveReport(report: org.json.JSONObject, keep: Int = 20): File {
        val dir = File(context.filesDir, "network-diagnostics").apply { mkdirs() }
        val stamp = SimpleDateFormat("yyyyMMdd'T'HHmmss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
        val tmp = File(dir, "$stamp.json.tmp")
        val out = File(dir, "$stamp.json")
        tmp.outputStream().use { it.write(report.toString(2).toByteArray(Charsets.UTF_8)); it.fd.sync() }
        if (!tmp.renameTo(out)) throw java.io.IOException("Could not finalize network report ${out.name}")
        dir.listFiles { f -> f.name.endsWith(".json") }?.sortedByDescending { it.name }?.drop(keep)?.forEach { it.delete() }
        return out
    }

    companion object {
        fun nowIso(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
    }
}
