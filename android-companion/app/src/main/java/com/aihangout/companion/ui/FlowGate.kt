package com.aihangout.companion.ui

import java.util.concurrent.atomic.AtomicReference

/**
 * One non-queuing busy gate for every flow that mutates the shared journal
 * (Run, Ask AI, Archive). A second flow while one is active is REFUSED, not
 * queued -- a queued duplicate would run against state the first flow just
 * changed. Pure and JVM-tested; MainActivity releases it in `finally`.
 */
class FlowGate {
    private val active = AtomicReference<String?>(null)

    /** True if acquired; false (and unchanged) if [owner] or anyone else already holds it. */
    fun tryAcquire(owner: String): Boolean = active.compareAndSet(null, owner)

    fun release(owner: String) { active.compareAndSet(owner, null) }

    fun activeOwner(): String? = active.get()
}
