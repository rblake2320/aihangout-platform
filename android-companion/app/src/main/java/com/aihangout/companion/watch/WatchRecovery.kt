package com.aihangout.companion.watch

import java.io.File

object WatchRecovery {
    /** Poll only the postcondition. Never repeat the notification side effect. */
    fun awaitVisible(now: ()->Long, pause: (Long)->Unit, observed: ()->Boolean): Boolean {
        val deadline=now()+2000L
        while(true) {
            if(observed()) return true
            val left=deadline-now()
            if(left<=0) return false
            pause(minOf(100L,left))
        }
    }
    fun sweepCaptures(directory: File, keepName: String?) {
        if(!directory.exists()) return
        require(directory.isDirectory) { "Capture cache is not a directory" }
        val entries=directory.listFiles() ?: error("Cannot inspect capture cache")
        for(file in entries) {
            if(file.name==keepName) continue
            // Only files created in our own dedicated directory; never recursive deletion.
            check(file.isFile && file.delete()) { "Could not remove orphan camera capture" }
        }
    }
}
