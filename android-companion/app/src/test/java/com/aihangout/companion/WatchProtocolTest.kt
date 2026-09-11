package com.aihangout.companion

import com.aihangout.companion.watch.WatchProtocol
import com.aihangout.companion.watch.WatchApi
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class WatchProtocolTest {
    private fun response()=JSONObject().put("success",true).put("requestId","request").put("eventId","event").put("status","analyzed").put("summary","Motion notification observed; inspect the view.").put("proposal",JSONObject().put("operation","show_local_checkin").put("text","Please check the camera view."))
    private fun refused(value: JSONObject) { assertThrows(IllegalArgumentException::class.java) { WatchProtocol.parse(value.toString(),"request","event") } }
    @Test fun validProposalAndNoProposal() {
        assertEquals(WatchProtocol.CHECKIN_TEXT,WatchProtocol.parse(response().toString(),"request","event").proposalText)
        assertNull(WatchProtocol.parse(response().put("proposal",JSONObject.NULL).toString(),"request","event").proposalText)
    }
    @Test fun strictBooleanAndBoundIds() {
        for(value in listOf<Any>("true",1,JSONObject.NULL,false)) refused(response().put("success",value))
        refused(response().put("requestId","other")); refused(response().put("eventId","other"))
    }
    @Test fun untrustedOperationAndTextRefused() {
        refused(response().put("proposal",JSONObject().put("operation","sms_send").put("text",WatchProtocol.CHECKIN_TEXT)))
        refused(response().put("proposal",JSONObject().put("operation",WatchProtocol.CHECKIN).put("text","Call emergency services")))
        refused(response().put("status","pending")); refused(response().put("summary",""))
    }
    @Test fun exactPackageOnly() { assertTrue(WatchProtocol.acceptsPackage("com.immediasemi.android.blink")); assertFalse(WatchProtocol.acceptsPackage("com.immediasemi.android.blink.fake")); assertFalse(WatchProtocol.acceptsPackage("com.android.messages")) }
    @Test fun motionFreshnessAndOtherAlerts() {
        val now=1_000_000L
        assertTrue(WatchProtocol.acceptsMotion(WatchProtocol.BLINK,"Motion detected","Living room",now,now))
        assertFalse(WatchProtocol.acceptsMotion(WatchProtocol.BLINK,"Camera offline","Living room",now,now))
        assertFalse(WatchProtocol.acceptsMotion(WatchProtocol.BLINK,"Motion detected","",now-600001,now))
        assertFalse(WatchProtocol.acceptsMotion(WatchProtocol.BLINK,"Motion detected","",now+30001,now))
        assertFalse(WatchProtocol.acceptsMotion("other.app","Motion detected","",now,now))
    }
    @Test fun actualHttpGetReconciliationDoesNotPost() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(response().toString()))
            WatchApi(server.url("/").toString()).reconcile("test-token","12345678-1234-1234-1234-123456789abc")
            val request=server.takeRequest()
            assertEquals("GET",request.method); assertEquals(0L,request.bodySize)
            assertEquals("Bearer test-token",request.getHeader("Authorization")); assertEquals(1,server.requestCount)
        }
    }
    @Test fun noRedirectFollowOrDuplicatePost() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(307).addHeader("Location","/redirect"))
            assertThrows(IllegalStateException::class.java) { WatchApi(server.url("/").toString()).analyze("test-token",JSONObject()) }
            assertEquals(1,server.requestCount); assertEquals("POST",server.takeRequest().method)
        }
    }
}
