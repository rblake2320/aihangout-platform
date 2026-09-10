package com.aihangout.companion

import com.aihangout.companion.ui.FlowGate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger

class FlowGateTest {
    @Test
    fun `a second flow is refused while the first holds the gate, and only the holder can release`() {
        val g = FlowGate()
        assertTrue(g.tryAcquire("run"))
        assertFalse(g.tryAcquire("ask"))
        assertFalse(g.tryAcquire("run"))
        g.release("ask")                      // not the holder: no effect
        assertEquals("run", g.activeOwner())
        g.release("run")
        assertNull(g.activeOwner())
        assertTrue(g.tryAcquire("archive"))
    }

    @Test
    fun `parallel acquisition from many threads admits exactly one`() {
        val g = FlowGate()
        val start = CountDownLatch(1)
        val done = CountDownLatch(16)
        val admitted = AtomicInteger()
        repeat(16) { i ->
            Thread {
                start.await()
                if (g.tryAcquire("t$i")) admitted.incrementAndGet()
                done.countDown()
            }.start()
        }
        start.countDown(); done.await()
        assertEquals(1, admitted.get())
    }
}
