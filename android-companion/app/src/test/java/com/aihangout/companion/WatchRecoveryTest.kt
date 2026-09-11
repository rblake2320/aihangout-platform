package com.aihangout.companion

import com.aihangout.companion.watch.WatchRecovery
import com.aihangout.companion.watch.WatchProtocol
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class WatchRecoveryTest {
    @Test fun asynchronousReadbackWaitsForEffect() {
        var time=0L; var reads=0
        assertTrue(WatchRecovery.awaitVisible({ time },{ time+=it }) { reads++; time>=300 })
        assertEquals(300,time); assertEquals(4,reads)
    }
    @Test fun missingEffectStopsAtTwoSeconds() {
        var time=0L; var reads=0
        assertFalse(WatchRecovery.awaitVisible({ time },{ time+=it }) { reads++; false })
        assertEquals(2000,time); assertEquals(21,reads)
    }
    @Test fun orphanPhotoRemovedWhileRestoredCaptureRetained() {
        val directory=Files.createTempDirectory("watch-capture-test").toFile()
        try {
            val pending=directory.resolve("watch-pending.jpg").apply { writeBytes(byteArrayOf(1,2,3)) }
            val orphan=directory.resolve("watch-orphan.jpg").apply { writeBytes(byteArrayOf(4,5,6)) }
            WatchRecovery.sweepCaptures(directory,pending.name)
            assertTrue(pending.exists()); assertFalse(orphan.exists())
            WatchRecovery.sweepCaptures(directory,null); assertFalse(pending.exists())
        } finally { directory.deleteRecursively() }
    }
    @Test fun failedAndPendingAreStrictlyBound() {
        val obj=JSONObject().put("success",false).put("requestId","r").put("eventId","e").put("status","failed")
        assertEquals("FAILED",WatchProtocol.reconciledState(obj.toString(),"r","e"))
        assertThrows(IllegalArgumentException::class.java) { WatchProtocol.reconciledState(obj.toString(),"other","e") }
        assertThrows(IllegalArgumentException::class.java) { WatchProtocol.reconciledState(obj.put("success","false").toString(),"r","e") }
        obj.put("success",false).put("status","pending")
        assertEquals("UNKNOWN",WatchProtocol.reconciledState(obj.toString(),"r","e"))
        obj.put("status","unknown")
        assertEquals("UNKNOWN",WatchProtocol.reconciledState(obj.toString(),"r","e"))
    }
}
