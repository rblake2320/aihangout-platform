package com.aihangout.companion.ui

/**
 * Bounded, truthful status panel model (Team/tasks/A1-phone-backend-outage-20260910.md:
 * repeated taps against a stopped backend appended raw IO exceptions without
 * limit and never said "disconnected"). The panel always leads with one
 * connection line and keeps only the newest [maxLines] transcript lines, so
 * an outage is stated plainly and cannot grow the panel forever. Pure: no
 * Android types, so it is JVM-tested.
 */
class StatusLog(private val maxLines: Int = 80, private val maxLineLength: Int = 2000) {
    private val lines = ArrayDeque<String>()
    var connection: String = "Connection: not attempted yet"
        private set
    var consecutiveFailures: Int = 0
        private set

    fun append(line: String): String {
        val bounded = if (line.length > maxLineLength) line.take(maxLineLength) + "… [truncated]" else line
        lines.addLast(bounded)
        while (lines.size > maxLines) lines.removeFirst()
        return render()
    }

    fun markConnected(baseUrl: String): String {
        consecutiveFailures = 0
        connection = "Connection: OK ($baseUrl)"
        return render()
    }

    /** [detail] is the exception class + message; bounded so a stack of
     * identical socket errors reads as one counted line, not a wall of text. */
    fun markDisconnected(baseUrl: String, detail: String): String {
        consecutiveFailures += 1
        val plural = if (consecutiveFailures == 1) "" else "s"
        connection = "Connection: DISCONNECTED from $baseUrl -- $consecutiveFailures consecutive failure$plural. " +
            "Nothing on the server changed because of this tap unless a POST was already in flight (see journal lines). " +
            "Last error: ${detail.take(160)}"
        return render()
    }

    fun render(): String = (listOf(connection) + lines).joinToString("\n")

    fun lineCount(): Int = lines.size
}
