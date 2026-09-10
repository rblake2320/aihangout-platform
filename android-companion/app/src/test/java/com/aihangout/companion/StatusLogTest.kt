package com.aihangout.companion

import com.aihangout.companion.ui.StatusLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StatusLogTest {

    @Test
    fun `the panel keeps only the newest lines and cannot grow without bound`() {
        val log = StatusLog(maxLines = 5)
        repeat(100) { log.append("line $it") }
        assertEquals(5, log.lineCount())
        val rendered = log.render()
        assertTrue(rendered.endsWith("line 99"))
        assertTrue(!rendered.contains("line 94\n"))
    }

    @Test
    fun `a single oversized line is truncated`() {
        val log = StatusLog(maxLines = 5, maxLineLength = 20)
        val rendered = log.append("x".repeat(100))
        assertTrue(rendered.contains("… [truncated]"))
        assertTrue(!rendered.contains("x".repeat(21)))
    }

    @Test
    fun `repeated disconnects are counted on one connection line, and a reconnect resets the count`() {
        val log = StatusLog()
        log.markDisconnected("http://127.0.0.1:8789", "java.net.SocketException: unexpected end of stream")
        val second = log.markDisconnected("http://127.0.0.1:8789", "java.net.SocketException: unexpected end of stream")
        assertEquals(2, log.consecutiveFailures)
        assertTrue(second.startsWith("Connection: DISCONNECTED from http://127.0.0.1:8789 -- 2 consecutive failures"))
        assertEquals(1, second.lines().count { it.startsWith("Connection:") })

        val ok = log.markConnected("http://127.0.0.1:8789")
        assertEquals(0, log.consecutiveFailures)
        assertTrue(ok.startsWith("Connection: OK"))
    }

    @Test
    fun `the connection line always renders first, ahead of the transcript`() {
        val log = StatusLog()
        log.append("Logging in...")
        val rendered = log.markDisconnected("http://h", "IOException: refused")
        assertTrue(rendered.lines()[0].startsWith("Connection: DISCONNECTED"))
        assertEquals("Logging in...", rendered.lines()[1])
    }
}
