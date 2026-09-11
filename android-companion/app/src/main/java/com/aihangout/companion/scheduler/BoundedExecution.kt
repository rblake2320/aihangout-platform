package com.aihangout.companion.scheduler

import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** Runs one operation under a hard time budget. Pure JVM; the receiver uses it
 * so a stalled read becomes an UNKNOWN row instead of an OS-killed process. */
object BoundedExecution {
    sealed class Outcome {
        data class Completed(val resultJson: String) : Outcome()
        data class TimedOut(val budgetMs: Long) : Outcome()
        data class Failed(val error: String) : Outcome()
    }

    /** Only the operation ids in [OperationRegistry.SUPPORTED] may reach [body]; everything else fails before running. */
    fun run(operation: String, budgetMs: Long, body: () -> String): Outcome {
        if (OperationRegistry.decide(operation) !is OperationRegistry.Decision.Supported) {
            return Outcome.Failed("operation '$operation' is not executable here")
        }
        val pool = Executors.newSingleThreadExecutor { r -> Thread(r, "scheduler-exec").apply { isDaemon = true } }
        return try {
            Outcome.Completed(pool.submit(body).get(budgetMs, TimeUnit.MILLISECONDS))
        } catch (e: TimeoutException) {
            Outcome.TimedOut(budgetMs)
        } catch (e: Exception) {
            Outcome.Failed("${(e.cause ?: e).javaClass.simpleName}: ${(e.cause ?: e).message}")
        } finally {
            pool.shutdownNow()
        }
    }
}
