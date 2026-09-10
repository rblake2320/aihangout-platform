package com.aihangout.companion

import com.aihangout.companion.data.DeviceBinding
import com.aihangout.companion.data.DeviceBinding.Resolution
import com.aihangout.companion.data.PhaseStore
import com.aihangout.companion.data.PhaseWriteException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceBindingTest {
    private class MemoryStore : PhaseStore {
        val map = HashMap<String, String>()
        override fun put(key: String, value: String): Boolean { map[key] = value; return true }
        override fun get(key: String): String? = map[key]
        override fun remove(key: String): Boolean { map.remove(key); return true }
    }
    private class HistoryFailingStore : PhaseStore {
        val map = HashMap<String, String>()
        override fun put(key: String, value: String): Boolean { if (key == DeviceBinding.HISTORY_KEY) return false; map[key] = value; return true }
        override fun get(key: String): String? = map[key]
        override fun remove(key: String): Boolean { map.remove(key); return true }
    }

    @Test
    fun `no binding and no legacy id means not enrolled`() {
        assertEquals(Resolution.None, DeviceBinding(MemoryStore()).resolve("7", "http://loop", null))
    }

    @Test
    fun `no binding plus a legacy id on ANY endpoint is never adopted on trust -- the loopback-to-staging case`() {
        val b = DeviceBinding(MemoryStore())
        val r = b.resolve("7", "https://staging", "dev-legacy-from-loopback")
        assertTrue(r is Resolution.LegacyUnbound)
        assertEquals(null, b.current())
        // still unbound on a second look; nothing was written
        assertTrue(b.resolve("7", "https://staging", "dev-legacy-from-loopback") is Resolution.LegacyUnbound)
    }

    @Test
    fun `a legacy id is bound only when the authenticated backend readback returns exactly that id`() {
        val b = DeviceBinding(MemoryStore())
        b.confirmLegacy("dev-legacy", "dev-legacy", "7", "http://loop")
        assertEquals(Resolution.Bound("dev-legacy"), b.resolve("7", "http://loop", "dev-legacy"))
        assertTrue(b.current()!!.getBoolean("migratedFromLegacy"))
        assertThrows(IllegalArgumentException::class.java) { DeviceBinding(MemoryStore()).confirmLegacy("dev-legacy", "dev-OTHER", "7", "http://loop") }
    }

    @Test
    fun `an unconfirmed legacy id is quarantined into history, never bound`() {
        val b = DeviceBinding(MemoryStore())
        b.archiveLegacy("dev-legacy", "not confirmed by https://staging")
        assertEquals(null, b.current())
        assertEquals("dev-legacy", b.history()[0].getString("legacyUnboundDeviceId"))
        assertEquals(Resolution.None, b.resolve("7", "https://staging", null))
    }

    @Test
    fun `a different backend is a transition -- the id is never silently reused`() {
        val b = DeviceBinding(MemoryStore())
        b.bind("dev-1", "7", "http://loop")
        val r = b.resolve("7", "https://staging", "dev-1")
        assertTrue(r is Resolution.Transition)
        assertEquals("http://loop", (r as Resolution.Transition).priorBaseUrl)
    }

    @Test
    fun `a different owner on the same backend is also a transition`() {
        val b = DeviceBinding(MemoryStore())
        b.bind("dev-1", "7", "http://loop")
        assertTrue(b.resolve("8", "http://loop", "dev-1") is Resolution.Transition)
    }

    @Test
    fun `archiving a transition keeps the prior binding in history and requires fresh enrollment`() {
        val b = DeviceBinding(MemoryStore())
        b.bind("dev-1", "7", "http://loop")
        b.archiveForTransition("backend changed to https://staging")
        assertEquals(Resolution.None, b.resolve("7", "https://staging", null))
        assertEquals(1, b.history().size)
        assertEquals("dev-1", b.history()[0].getJSONObject("binding").getString("deviceId"))
        assertNotNull(b.history()[0].getString("reason"))
    }

    @Test
    fun `a failed history append leaves the prior binding active`() {
        val b = DeviceBinding(HistoryFailingStore())
        b.bind("dev-1", "7", "http://loop")
        assertThrows(PhaseWriteException::class.java) { b.archiveForTransition("x") }
        assertEquals(Resolution.Bound("dev-1"), b.resolve("7", "http://loop", null))
    }
}
