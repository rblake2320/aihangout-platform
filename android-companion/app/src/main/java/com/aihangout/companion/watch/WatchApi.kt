package com.aihangout.companion.watch

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class WatchApi(private val baseUrl: String) {
    private val client = OkHttpClient.Builder().retryOnConnectionFailure(false).followRedirects(false).followSslRedirects(false).callTimeout(45,TimeUnit.SECONDS).build()
    fun owner(jwt: String): String {
        val raw = call(Request.Builder().url(baseUrl.trimEnd('/')+"/api/auth/me").header("Authorization","Bearer $jwt").get().build())
        val obj = JSONObject(raw)
        require(obj.opt("success") == true)
        return obj.getJSONObject("user").get("id").toString()
    }
    fun analyze(jwt: String, payload: JSONObject): String = call(Request.Builder().url(baseUrl.trimEnd('/')+"/api/mobile/camera-analysis").header("Authorization","Bearer $jwt").post(payload.toString().toRequestBody("application/json".toMediaType())).build())
    fun reconcile(jwt: String, id: String): String {
        require(id.matches(Regex("[a-f0-9-]{36}")))
        return call(Request.Builder().url(baseUrl.trimEnd('/')+"/api/mobile/camera-analysis/"+id).header("Authorization","Bearer $jwt").get().build())
    }
    private fun call(request: Request): String = client.newCall(request).execute().use { r ->
        check(r.isSuccessful) { "Analysis HTTP ${r.code}; use GET reconciliation, do not resend" }
        val body = checkNotNull(r.body)
        val bytes = body.byteStream().use { input ->
            val out = java.io.ByteArrayOutputStream()
            val chunk = ByteArray(4096)
            while(out.size() <= 131072) { val count=input.read(chunk); if(count<0) break; out.write(chunk,0,count) }
            out.toByteArray()
        }
        check(bytes.size <= 131072) { "Analysis response too large" }
        bytes.toString(Charsets.UTF_8)
    }
}
