package com.aihangout.companion.notes

/**
 * Normalisation applied to text before it becomes a note. OCR output and the
 * human's edits both pass through here: control characters are stripped
 * (except newline and tab), line endings unified, trailing whitespace per line
 * removed, runs of blank lines collapsed, and the total length bounded so a
 * note file can never grow without limit.
 */
object NoteText {
    const val MAX_CHARS = 20_000

    data class Normalized(val text: String, val truncated: Boolean) {
        val isBlank: Boolean get() = text.isBlank()
    }

    fun normalize(raw: String): Normalized {
        val unified = raw.replace("\r\n", "\n").replace('\r', '\n')
        val cleaned = buildString(unified.length) {
            for (ch in unified) {
                val keep = ch == '\n' || ch == '\t' || (!ch.isISOControl() && ch != '\uFEFF')
                if (keep) append(ch)
            }
        }
        val lines = cleaned.split('\n').map { it.trimEnd() }
        val collapsed = ArrayList<String>(lines.size)
        var blankRun = 0
        for (line in lines) {
            if (line.isEmpty()) { blankRun++; if (blankRun > 1) continue } else blankRun = 0
            collapsed.add(line)
        }
        val joined = collapsed.joinToString("\n").trim()
        return if (joined.length > MAX_CHARS) Normalized(joined.substring(0, MAX_CHARS), truncated = true)
        else Normalized(joined, truncated = false)
    }
}
