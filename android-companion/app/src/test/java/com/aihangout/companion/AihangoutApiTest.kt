package com.aihangout.companion

import com.aihangout.companion.net.AihangoutApi
import com.aihangout.companion.net.AihangoutApiException
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Real HTTP over loopback via MockWebServer (OkHttp's own test-support
 * library, not a mocked interface) -- matches this project's own no-mocks
 * testing discipline: an actual HTTP request is sent, an actual response
 * is parsed, per the QA-plan design's recommendation.
 */
class AihangoutApiTest {
    private lateinit var server: MockWebServer
    private lateinit var api: AihangoutApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = AihangoutApi(server.url("/").toString().trimEnd('/'))
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `login sends the real request body and returns the token and userId from a real response`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            JSONObject().put("success", true).put("token", "jwt-abc123")
                .put("user", JSONObject().put("id", 1).put("username", "u")).toString()
        ))

        val result = api.login("a@b.test", "pw12345678")
        assertEquals("jwt-abc123", result.jwt)
        assertEquals("1", result.userId)

        val recorded = server.takeRequest()
        assertEquals("/api/auth/login", recorded.path)
        assertEquals("POST", recorded.method)
        val sentBody = JSONObject(recorded.body.readUtf8())
        assertEquals("a@b.test", sentBody.getString("email"))
        assertEquals("pw12345678", sentBody.getString("password"))
    }

    @Test
    fun `login failure surfaces the real HTTP status and server error message`() {
        server.enqueue(MockResponse().setResponseCode(401).setBody(
            JSONObject().put("success", false).put("error", "Invalid credentials").toString()
        ))
        val ex = assertThrows(AihangoutApiException::class.java) {
            api.login("a@b.test", "wrong")
        }
        assertEquals(401, ex.httpStatus)
        assertTrue(ex.message!!.contains("Invalid credentials"))
    }

    @Test
    fun `createIntent sends every required field and the Authorization header`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            JSONObject().put("success", true).put("actionId", "act-1").put("actionDigest", "deadbeef")
                .put("riskTier", "read_only").put("status", "awaiting_approval").put("expiresAt", "2026-01-01T00:00:00Z").toString()
        ))

        val result = api.createIntent("jwt-xyz", "dev-1", "battery_status_read", "Check battery", "idem-key-12345678")
        assertEquals("act-1", result.getString("actionId"))

        val recorded = server.takeRequest()
        assertEquals("Bearer jwt-xyz", recorded.getHeader("Authorization"))
        val body = JSONObject(recorded.body.readUtf8())
        assertEquals("dev-1", body.getString("deviceId"))
        assertEquals("battery_status_read", body.getString("capability"))
        assertEquals("Check battery", body.getString("targetDescription"))
        assertEquals("idem-key-12345678", body.getString("idempotencyKey"))
    }

    @Test
    fun `reportResult omits resultPayloadHash from the body when null, includes it when present`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            JSONObject().put("success", true).put("actionId", "act-1").toString()
        ))
        api.reportResult("jwt", "act-1", "dev-1", "idem-1", "failed", null)
        val recorded = server.takeRequest()
        val body = JSONObject(recorded.body.readUtf8())
        assertTrue(!body.has("resultPayloadHash"))

        server.enqueue(MockResponse().setResponseCode(200).setBody(
            JSONObject().put("success", true).put("actionId", "act-2").toString()
        ))
        api.reportResult("jwt", "act-2", "dev-1", "idem-2", "executed", "sha256:abc")
        val recorded2 = server.takeRequest()
        val body2 = JSONObject(recorded2.body.readUtf8())
        assertEquals("sha256:abc", body2.getString("resultPayloadHash"))
    }

    @Test
    fun `getAction is a real GET with no request body and the Authorization header`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            JSONObject().put("success", true)
                .put("intent", JSONObject().put("action_id", "act-1").put("status", "approved"))
                .put("approval", JSONObject.NULL).put("result", JSONObject.NULL).put("effect", JSONObject.NULL)
                .toString()
        ))
        val result = api.getAction("jwt-abc", "act-1")
        assertEquals("approved", result.getJSONObject("intent").getString("status"))

        val recorded = server.takeRequest()
        assertEquals("GET", recorded.method)
        assertEquals("/api/mobile/actions/act-1", recorded.path)
        assertEquals("Bearer jwt-abc", recorded.getHeader("Authorization"))
    }

    @Test
    fun `falseSuccessMustRefuse -- a 2xx response with success false is still a failure`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            JSONObject().put("success", false).put("error", "something went wrong server-side").toString()
        ))
        val ex = assertThrows(AihangoutApiException::class.java) {
            api.getAction("jwt", "act-1")
        }
        assertTrue(ex.message!!.contains("something went wrong server-side"))
    }

    @Test
    fun `malformedSuccessMustRefuse -- a non-JSON 2xx body is refused, never silently treated as empty success`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("not json at all"))
        assertThrows(AihangoutApiException::class.java) {
            api.getAction("jwt", "act-1")
        }
    }

    @Test
    fun `foreignIdentityMustRefuse -- getAction refuses a response bound to a different action_id`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            JSONObject().put("success", true)
                .put("intent", JSONObject().put("action_id", "act-DIFFERENT").put("status", "approved"))
                .put("approval", JSONObject.NULL).put("result", JSONObject.NULL).put("effect", JSONObject.NULL)
                .toString()
        ))
        assertThrows(com.aihangout.companion.net.ResponseIntegrityException::class.java) {
            api.getAction("jwt", "act-1")
        }
    }

    @Test
    fun `foreignIdentityMustRefuse -- reportResult refuses a response echoing a different actionId`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            JSONObject().put("success", true).put("actionId", "act-DIFFERENT").toString()
        ))
        assertThrows(com.aihangout.companion.net.ResponseIntegrityException::class.java) {
            api.reportResult("jwt", "act-1", "dev-1", "idem-1", "executed", null)
        }
    }
}
