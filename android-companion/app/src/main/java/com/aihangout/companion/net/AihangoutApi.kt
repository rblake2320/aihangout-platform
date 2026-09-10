package com.aihangout.companion.net

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class AihangoutApiException(val httpStatus: Int, message: String) : Exception(message)

/** Thrown when a response is well-formed JSON with success:true but is
 * bound to a different identity than what was requested (e.g. an
 * actionId echoed back that doesn't match the one asked for). This is
 * never a legitimate outcome -- refusing beats trusting a response that
 * might belong to a different resource. */
class ResponseIntegrityException(message: String) : Exception(message)

data class LoginResult(val jwt: String, val userId: String)

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
            val text = resp.body?.string() ?: ""
            // A malformed/empty body is never a success, regardless of HTTP
            // status -- it used to silently become {} and fall through as
            // "success" whenever the status code also happened to be < 400.
            val json = try { JSONObject(text) } catch (e: Exception) {
                throw ResponseIntegrityException("Response body was not valid JSON (HTTP ${resp.code}); operation outcome is unknown")
            }
            // success:true is required unconditionally, not only checked
            // together with resp.code >= 400 -- a 2xx response with
            // success:false must still be treated as a failure.
            //
            // Compare the RAW value to the literal Boolean true only. org.json's
            // optBoolean() coerces the STRING "true" to true, so a 200 body of
            // {"success":"true"} used to be credited as success (reviewer A2,
            // reproduced over a real loopback socket). A JSON `true` literal
            // parses to java.lang.Boolean.TRUE, so `== true` (equals) accepts
            // only that; a String, a number, JSON null or a missing key all fail.
            val success: Any? = json.opt("success")
            if (!resp.isSuccessful || success != true) {
                val serverError = json.optString("error", "HTTP ${resp.code}")
                val detail = if (success is Boolean) serverError
                    else "$serverError -- success flag was not a literal boolean true (got ${if (success == null) "missing" else "${success.javaClass.simpleName} $success"})"
                if (resp.code in 400..499 && success == false) {
                    throw AihangoutApiException(resp.code, detail)
                }
                throw ResponseIntegrityException("$detail; operation outcome is unknown (HTTP ${resp.code})")
            }
            return json
        }
    }

    fun login(email: String, password: String): LoginResult {
        val res = request("/api/auth/login", "POST", JSONObject().put("email", email).put("password", password), null)
        val jwt = res.getString("token")
        val userId = res.getJSONObject("user").getLong("id").toString()
        return LoginResult(jwt, userId)
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

    fun getAction(jwt: String, actionId: String): JSONObject {
        val json = request("/api/mobile/actions/$actionId", "GET", null, jwt)
        val returnedId = json.optJSONObject("intent")?.optString("action_id")
        if (returnedId != actionId) {
            throw ResponseIntegrityException("getAction($actionId) returned data for a different action_id ($returnedId) -- refusing to use it")
        }
        return json
    }

    fun reportResult(jwt: String, actionId: String, deviceId: String, idempotencyKey: String, resultStatus: String, resultPayloadHash: String?): JSONObject {
        val body = JSONObject()
            .put("deviceId", deviceId)
            .put("idempotencyKey", idempotencyKey)
            .put("resultStatus", resultStatus)
        if (resultPayloadHash != null) body.put("resultPayloadHash", resultPayloadHash)
        val json = request("/api/mobile/actions/$actionId/result", "POST", body, jwt)
        val returnedId = json.optString("actionId")
        if (returnedId != actionId) {
            throw ResponseIntegrityException("reportResult($actionId) response echoed a different actionId ($returnedId) -- refusing to trust it")
        }
        return json
    }
}
