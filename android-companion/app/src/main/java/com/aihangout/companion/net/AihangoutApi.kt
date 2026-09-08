package com.aihangout.companion.net

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class AihangoutApiException(val httpStatus: Int, message: String) : Exception(message)

/**
 * Thin client for the AIHangout mobile-companion backend contract
 * (Team/tasks/A3-to-A1-current-help-20260908.md /
 * A1-to-A3-enrollment-contract-20260908.md). Takes an injected
 * OkHttpClient and baseUrl so tests can point it at a real
 * MockWebServer instance (real HTTP over loopback, per this project's
 * own no-mocks testing discipline) instead of a fake interface.
 */
class AihangoutApi(
    private val baseUrl: String,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()
) {
    private val jsonMediaType = "application/json".toMediaType()

    private fun request(path: String, method: String, body: JSONObject?, jwt: String?): JSONObject {
        val builder = Request.Builder().url(baseUrl + path)
        if (jwt != null) builder.header("Authorization", "Bearer $jwt")
        val bodyStr = (body ?: JSONObject()).toString()
        when (method) {
            "GET" -> builder.get()
            "POST" -> builder.post(bodyStr.toRequestBody(jsonMediaType))
            else -> throw IllegalArgumentException("unsupported method $method")
        }
        client.newCall(builder.build()).execute().use { resp ->
            val text = resp.body?.string() ?: "{}"
            val json = try { JSONObject(text) } catch (e: Exception) { JSONObject() }
            if (!resp.isSuccessful || json.optBoolean("success", false).not() && resp.code >= 400) {
                throw AihangoutApiException(resp.code, json.optString("error", "HTTP ${resp.code}"))
            }
            return json
        }
    }

    fun login(email: String, password: String): String {
        val res = request("/api/auth/login", "POST", JSONObject().put("email", email).put("password", password), null)
        return res.getString("token")
    }

    fun requestChallenge(jwt: String, agentName: String, publicKeySpkiBase64: String, packageName: String, signingCertSha256: String): JSONObject {
        val body = JSONObject()
            .put("agentName", agentName)
            .put("publicKeySpki", publicKeySpkiBase64)
            .put("packageName", packageName)
            .put("signingCertSha256", signingCertSha256)
        return request("/api/mobile/devices/challenge", "POST", body, jwt)
    }

    fun enroll(
        jwt: String, agentName: String, publicKeySpkiBase64: String, packageName: String,
        signingCertSha256: String, challengeId: String, signatureBase64: String
    ): JSONObject {
        val body = JSONObject()
            .put("agentName", agentName)
            .put("publicKeySpki", publicKeySpkiBase64)
            .put("packageName", packageName)
            .put("signingCertSha256", signingCertSha256)
            .put("challengeId", challengeId)
            .put("signature", signatureBase64)
        return request("/api/mobile/devices/enroll", "POST", body, jwt)
    }

    fun createIntent(jwt: String, deviceId: String, capability: String, targetDescription: String, idempotencyKey: String): JSONObject {
        val body = JSONObject()
            .put("deviceId", deviceId)
            .put("capability", capability)
            .put("targetDescription", targetDescription)
            .put("idempotencyKey", idempotencyKey)
        return request("/api/mobile/actions/intent", "POST", body, jwt)
    }

    fun getAction(jwt: String, actionId: String): JSONObject =
        request("/api/mobile/actions/$actionId", "GET", null, jwt)

    fun reportResult(jwt: String, actionId: String, deviceId: String, idempotencyKey: String, resultStatus: String, resultPayloadHash: String?): JSONObject {
        val body = JSONObject()
            .put("deviceId", deviceId)
            .put("idempotencyKey", idempotencyKey)
            .put("resultStatus", resultStatus)
        if (resultPayloadHash != null) body.put("resultPayloadHash", resultPayloadHash)
        return request("/api/mobile/actions/$actionId/result", "POST", body, jwt)
    }
}
