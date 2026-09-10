package com.aihangout.companion.notes

import org.json.JSONObject
import java.io.File
import java.util.UUID

/** One saved camera note. Text only -- the source photo is never retained. */
data class CameraNote(
    val id: String,
    val createdAtEpochMs: Long,
    val text: String,
    /** SHA-256 (lowercase hex) of the captured image the text came from; provenance only. */
    val sourceImageSha256: String?,
    /** Which on-device recogniser produced the initial text (the human may have edited it since). */
    val ocrEngine: String,
    val truncated: Boolean
) {
    fun toJson(): JSONObject = JSONObject()
        .put("schema", SCHEMA)
        .put("id", id)
        .put("createdAtEpochMs", createdAtEpochMs)
        .put("text", text)
        .put("sourceImageSha256", sourceImageSha256 ?: JSONObject.NULL)
        .put("ocrEngine", ocrEngine)
        .put("truncated", truncated)

    companion object {
        const val SCHEMA = "aihangout-camera-note-v1"
        val ID_RE = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

        fun fromJson(o: JSONObject): CameraNote {
            require(o.getString("schema") == SCHEMA) { "unknown note schema" }
            val id = o.getString("id")
            require(ID_RE.matches(id)) { "bad note id" }
            return CameraNote(
                id = id,
                createdAtEpochMs = o.getLong("createdAtEpochMs"),
                text = o.getString("text"),
                sourceImageSha256 = if (o.isNull("sourceImageSha256")) null else o.getString("sourceImageSha256"),
                ocrEngine = o.getString("ocrEngine"),
                truncated = o.optBoolean("truncated", false)
            )
        }
    }
}

/**
 * App-private durable note store: one JSON file per note under [dir]
 * (intended: `context.filesDir/camera-notes`). Writes are atomic
 * (temp file + rename) so a crash mid-save leaves either the previous state
 * or a complete note, never a half-written file that reads back as a note.
 * Corrupt files are skipped on read and left on disk (evidence preserved,
 * never auto-deleted). Pure JVM code -- unit-tested without Android.
 */
class NoteStore(private val dir: File) {

    /** Persist [text] as a new note. Refuses blank text (returns null, writes nothing). */
    fun save(
        text: String,
        sourceImageSha256: String?,
        ocrEngine: String,
        nowEpochMs: Long,
        id: String = UUID.randomUUID().toString()
    ): CameraNote? {
        require(CameraNote.ID_RE.matches(id)) { "bad note id" }
        val normalized = NoteText.normalize(text)
        if (normalized.isBlank) return null
        if (!dir.isDirectory && !dir.mkdirs()) throw java.io.IOException("cannot create note directory")
        val note = CameraNote(id, nowEpochMs, normalized.text, sourceImageSha256, ocrEngine, normalized.truncated)
        val target = fileFor(id)
        if (target.exists()) throw IllegalStateException("note id already exists")
        val tmp = File(dir, "$id.json.tmp")
        val bytes = note.toJson().toString().toByteArray(Charsets.UTF_8)
        java.io.FileOutputStream(tmp).use { out ->
            out.write(bytes)
            out.flush()
            out.fd.sync() // durable before the rename makes it visible (crash / power loss safe)
        }
        if (!tmp.renameTo(target)) {
            // Windows/exotic FS fallback: copy then delete; still never leaves a partial target.
            target.writeBytes(tmp.readBytes())
            tmp.delete()
        }
        return note
    }

    /**
     * Remove `.json.tmp` leftovers from a save interrupted before its rename.
     * They are never read as notes (list/load only see `.json`), so this is
     * hygiene, not recovery: an interrupted save produced no note by design.
     * Returns how many were removed.
     */
    fun sweepStaleTemp(): Int {
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".json.tmp") } ?: return 0
        return files.count { it.delete() }
    }

    /** All readable notes, newest first. Corrupt files are ignored, not deleted. */
    fun list(): List<CameraNote> {
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".json") } ?: return emptyList()
        return files.mapNotNull { readNote(it) }.sortedWith(compareByDescending<CameraNote> { it.createdAtEpochMs }.thenBy { it.id })
    }

    /** Number of `.json` files present that do not parse as a note (diagnostic only). */
    fun corruptCount(): Int {
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".json") } ?: return 0
        return files.count { readNote(it) == null }
    }

    fun load(id: String): CameraNote? {
        if (!CameraNote.ID_RE.matches(id)) return null // never build a path from unvalidated input
        val f = fileFor(id)
        return if (f.isFile) readNote(f) else null
    }

    private fun fileFor(id: String) = File(dir, "$id.json")

    private fun readNote(f: File): CameraNote? = try {
        val note = CameraNote.fromJson(JSONObject(f.readText(Charsets.UTF_8)))
        if (f.name == "${note.id}.json") note else null // file name must match the id inside it
    } catch (e: Exception) {
        null
    }
}
