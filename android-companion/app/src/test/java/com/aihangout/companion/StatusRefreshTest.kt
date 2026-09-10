package com.aihangout.companion

import com.aihangout.companion.data.ResultSnapshot
import com.aihangout.companion.data.StatusRefresh
import com.aihangout.companion.data.StatusRefresh.Outcome
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StatusRefreshTest {
    private val cached = ResultSnapshot("act-1", "dev-1", "7", "http://h", "approved", "executed", "unconfirmed", 1000L, "reported")

    private fun readback(actionId: String = "act-1", status: String = "approved", effect: String? = "unconfirmed", result: String? = "executed"): JSONObject =
        JSONObject().put("success", true)
            .put("intent", JSONObject().put("action_id", actionId).put("device_id", "dev-1").put("status", status))
            .put("result", result?.let { JSONObject().put("result_status", it) } ?: JSONObject.NULL)
            .put("effect", effect?.let { JSONObject().put("effect_status", it) } ?: JSONObject.NULL)

    @Test
    fun `a later effect_verified on the server replaces the cached unconfirmed display`() {
        val o = StatusRefresh.merge(cached, readback(effect = "effect_verified"), false, "7", "http://h", 2000L) as Outcome.Updated
        assertEquals("effect_verified", o.snapshot.effectStatus)
        assertEquals("refreshed", o.snapshot.source)
        assertTrue(o.whatChanged.contains("effect unconfirmed->effect_verified"))
        assertTrue(o.snapshot.render().endsWith("[refreshed from server]"))
    }

    @Test
    fun `offline preserves the cached evidence and marks it clearly`() {
        val o = StatusRefresh.merge(cached, null, true, "7", "http://h", 2000L) as Outcome.OfflinePreserved
        assertEquals("unconfirmed", o.snapshot.effectStatus)
        assertTrue(o.snapshot.render().contains("[CACHED, NOT REFRESHED: offline"))
    }

    @Test
    fun `a 404 preserves the cached evidence with an explicit server-unknown marker`() {
        val o = StatusRefresh.merge(cached, null, false, "7", "http://h", 2000L) as Outcome.ServerUnknownPreserved
        assertTrue(o.snapshot.render().contains("server no longer returns action act-1"))
    }

    @Test
    fun `unchanged server state is reported as unchanged but now marked refreshed`() {
        val o = StatusRefresh.merge(cached, readback(), false, "7", "http://h", 2000L) as Outcome.Unchanged
        assertEquals("refreshed", o.snapshot.source)
    }

    @Test
    fun `a snapshot from another owner or backend, or a readback for another action, is never applied`() {
        assertTrue(StatusRefresh.merge(cached, readback(effect = "effect_verified"), false, "8", "http://h", 2000L) is Outcome.ForeignRefused)
        assertTrue(StatusRefresh.merge(cached, readback(effect = "effect_verified"), false, "7", "https://other", 2000L) is Outcome.ForeignRefused)
        val o = StatusRefresh.merge(cached, readback(actionId = "act-2", effect = "effect_verified"), false, "7", "http://h", 2000L) as Outcome.ForeignRefused
        assertEquals("unconfirmed", o.snapshot.effectStatus)
    }

    @Test
    fun `expiry on the server replaces the cached status without inventing a result`() {
        val pending = cached.copy(status = "awaiting_approval", resultStatus = null, effectStatus = null)
        val o = StatusRefresh.merge(pending, readback(status = "expired", result = null, effect = null), false, "7", "http://h", 2000L) as Outcome.Updated
        assertEquals("expired", o.snapshot.status)
        assertEquals(null, o.snapshot.resultStatus)
    }

    @Test
    fun `json round trip preserves identity, freshness and the stale note`() {
        val s = cached.copy(staleNote = "offline since 1000")
        val back = ResultSnapshot.fromJson(s.toJson())
        assertEquals(s, back)
    }
}
