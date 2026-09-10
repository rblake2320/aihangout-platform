package com.aihangout.companion

import com.aihangout.companion.data.AssistanceOutcome
import com.aihangout.companion.data.AssistanceOutcome.Kind
import com.aihangout.companion.data.AssistanceRecord
import com.aihangout.companion.data.PhaseStore
import com.aihangout.companion.net.AihangoutApi
import com.aihangout.companion.net.AihangoutApiException
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** A5 contract: 424 unknown/failed, 409 stored status; only `failed` permits a new id. */
class AssistanceOutcomeTest {
    private class MemoryStore : PhaseStore {
        val map = HashMap<String, String>()
        override fun put(key: String, value: String): Boolean { map[key] = value; return true }
        override fun get(key: String): String? = map[key]
        override fun remove(key: String): Boolean { map.remove(key); return true }
    }
    private fun body(status: String, extra: Map<String, Any> = emptyMap()) =
        JSONObject().put("success", false).put("requestId", "r1").put("status", status).also { j -> extra.forEach { (k, v) -> j.put(k, v) } }

    @Test
    fun `424 unknown and 409 pending or unknown are Unknown -- never Failed`() {
        assertTrue(AssistanceOutcome.fromError(424, body("unknown"), "timeout") is Kind.Unknown)
        assertTrue(AssistanceOutcome.fromError(409, body("pending"), "dup") is Kind.Unknown)
        assertTrue(AssistanceOutcome.fromError(409, body("unknown"), "dup") is Kind.Unknown)
        // a 424 with no status is still not guessed as failed
        assertTrue(AssistanceOutcome.fromError(424, JSONObject().put("success", false), "x") is Kind.Unknown)
    }

    @Test
    fun `424 failed, 409 failed and other 4xx are authoritative failures`() {
        assertTrue(AssistanceOutcome.fromError(424, body("failed"), "model text unparseable") is Kind.Failed)
        assertTrue(AssistanceOutcome.fromError(409, body("failed"), "dup") is Kind.Failed)
        assertTrue(AssistanceOutcome.fromError(403, JSONObject().put("success", false), "not yours") is Kind.Failed)
    }

    @Test
    fun `GET readback classifies stored outcomes and null means the server never saw the id`() {
        assertNull(AssistanceOutcome.fromReadback(null))
        assertTrue(AssistanceOutcome.fromReadback(body("pending")) is Kind.Unknown)
        assertTrue(AssistanceOutcome.fromReadback(body("failed", mapOf("error" to "boom"))) is Kind.Failed)
        assertTrue(AssistanceOutcome.fromReadback(body("completed", mapOf("diagnosis" to "off"))) is Kind.Answered)
    }

    @Test
    fun `424 unknown then restart and tap keeps the SAME requestId and does not mint a new one`() {
        val store = MemoryStore()
        val r = AssistanceRecord(store, "7", "https://h")
        val first = r.beginOrResume("dev-1")
        // simulate the POST outcome as the Activity does: Unknown -> record untouched
        val k = AssistanceOutcome.fromError(424, body("unknown"), "timeout")
        assertTrue(k is Kind.Unknown)
        // "restart": a fresh record object over the same store
        val again = AssistanceRecord(store, "7", "https://h").beginOrResume("dev-1")
        assertEquals(first.requestId, again.requestId)
        assertEquals("PENDING", again.status)
        // only an authoritative failure unlocks a new id
        r.markFailed("HTTP 424 failed")
        assertTrue(AssistanceRecord(store, "7", "https://h").beginOrResume("dev-1").requestId != first.requestId)
    }

    @Test
    fun `disabled and unconfigured are setup requirements rather than uncertain provider outcomes`() {
        for (status in listOf("disabled", "not_configured")) {
            assertTrue(AssistanceOutcome.fromError(424, body(status), "setup") is Kind.SetupRequired)
        }
        assertTrue(AssistanceOutcome.fromError(424, body("unknown"), "timeout") is Kind.Unknown)
    }

    @Test
    fun `the API surfaces the 424 body so the classifier can read status, and getAssistance binds the requestId`() {
        val server = MockWebServer(); server.start()
        try {
            val api = AihangoutApi(server.url("/").toString().trimEnd('/'))
            server.enqueue(MockResponse().setResponseCode(424).setBody(body("unknown", mapOf("error" to "provider timeout")).toString()))
            val ex = assertThrows(AihangoutApiException::class.java) { api.requestAssistance("jwt", "dev-1", "r1", false, "0.1.0") }
            assertEquals(424, ex.httpStatus)
            assertEquals("unknown", ex.body!!.getString("status"))

            server.enqueue(MockResponse().setResponseCode(200).setBody(JSONObject().put("success", true).put("requestId", "r1").put("status", "unknown").toString()))
            assertEquals("unknown", api.getAssistance("jwt", "r1")!!.getString("status"))
            server.takeRequest() // the POST above
            assertEquals("/api/mobile/assistance/r1", server.takeRequest().path)

            server.enqueue(MockResponse().setResponseCode(404).setBody(JSONObject().put("success", false).put("error", "nope").toString()))
            assertNull(api.getAssistance("jwt", "r1"))

            server.enqueue(MockResponse().setResponseCode(200).setBody(JSONObject().put("success", true).put("requestId", "OTHER").put("status", "failed").toString()))
            assertThrows(com.aihangout.companion.net.ResponseIntegrityException::class.java) { api.getAssistance("jwt", "r1") }
        } finally { server.shutdown() }
    }
}
