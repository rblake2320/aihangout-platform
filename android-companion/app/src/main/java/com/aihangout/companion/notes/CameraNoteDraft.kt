package com.aihangout.companion.notes

/**
 * The rules of a camera note, independent of Android and of the OCR engine:
 *
 *   Idle -> AwaitingCapture -> Captured -> Recognizing -> Recognized -> Saved
 *                 |               |            |             |
 *          cancelled/denied   (n/a)      recognition     discard
 *                 v                        failed           v
 *              NoNote                        v            NoNote
 *                                          NoNote
 *
 * A note can ONLY be produced by [save] from [State.Recognized] with non-blank
 * text, and [save] persists the text as it stands after the human's edits --
 * never the raw OCR output unless the human left it unchanged. Every cancel /
 * denial / failure path lands in [State.NoNote] and nothing is written.
 * Pure Kotlin so the rules are unit-tested without a device.
 */
class CameraNoteDraft(private val store: NoteStore) {

    sealed class State {
        object Idle : State()
        object AwaitingCapture : State()
        data class Captured(val imageSha256: String) : State()
        data class Recognizing(val imageSha256: String) : State()
        data class Recognized(val imageSha256: String, val engine: String, val ocrText: String, val text: String, val edited: Boolean) : State()
        data class Saved(val note: CameraNote) : State()
        data class NoNote(val reason: String) : State()
    }

    var state: State = State.Idle
        private set

    /** Only one capture at a time; refused (false) while a capture or recognition is in flight. */
    fun startCapture(): Boolean {
        return when (state) {
            State.Idle, is State.Saved, is State.NoNote -> { state = State.AwaitingCapture; true }
            else -> false
        }
    }

    /** Result of the system camera round-trip. `captured=false` is the user cancelling: no note. */
    fun captureResult(captured: Boolean, imageSha256: String?) {
        check(state is State.AwaitingCapture) { "captureResult outside AwaitingCapture" }
        state = if (captured && imageSha256 != null) State.Captured(imageSha256) else State.NoNote("capture cancelled")
    }

    /** Camera permission / camera app unavailable: no note, nothing written. */
    fun permissionDenied() {
        state = State.NoNote("camera permission denied or no camera available")
    }

    fun startRecognition() {
        val s = state
        check(s is State.Captured) { "startRecognition outside Captured" }
        state = State.Recognizing(s.imageSha256)
    }

    fun recognized(engine: String, ocrText: String) {
        val s = state
        check(s is State.Recognizing) { "recognized outside Recognizing" }
        val normalized = NoteText.normalize(ocrText).text
        state = State.Recognized(s.imageSha256, engine, normalized, normalized, edited = false)
    }

    fun recognitionFailed(reason: String) {
        check(state is State.Recognizing) { "recognitionFailed outside Recognizing" }
        state = State.NoNote("recognition failed: $reason")
    }

    /** The human's edit of the extracted text. Allowed only while a recognised draft is open. */
    fun edit(text: String): Boolean {
        val s = state as? State.Recognized ?: return false
        state = s.copy(text = text, edited = text != s.ocrText)
        return true
    }

    /** Explicit save. Returns the note, or null when refused (wrong state or blank text) -- nothing written when null. */
    fun save(nowEpochMs: Long): CameraNote? {
        val s = state as? State.Recognized ?: return null
        val note = store.save(s.text, s.imageSha256, s.engine, nowEpochMs) ?: return null
        state = State.Saved(note)
        return note
    }

    fun discard() {
        state = when (state) {
            is State.Saved -> state // a saved note is not un-saved by discarding the screen
            else -> State.NoNote("discarded by the user")
        }
    }

    /**
     * Recreation support (rotation / process death while the camera app is open
     * or while the human is editing). Only the states that carry unsaved human
     * work or an in-flight capture are snapshotted; everything else restores to
     * Idle. Pure JSON so the round-trip is unit-tested.
     */
    fun snapshot(): String {
        val o = org.json.JSONObject().put("schema", SNAPSHOT_SCHEMA)
        when (val s = state) {
            is State.AwaitingCapture -> o.put("kind", "awaiting")
            is State.Recognized -> o.put("kind", "recognized").put("sha", s.imageSha256).put("engine", s.engine).put("ocrText", s.ocrText).put("text", s.text)
            else -> o.put("kind", "idle")
        }
        return o.toString()
    }

    /** Restore from [snapshot]; malformed or unknown input is contained and yields Idle (never throws). */
    fun restore(json: String?) {
        state = try {
            val o = org.json.JSONObject(json ?: "")
            if (o.optString("schema") != SNAPSHOT_SCHEMA) State.Idle
            else when (o.optString("kind")) {
                "awaiting" -> State.AwaitingCapture
                "recognized" -> {
                    val sha = o.getString("sha"); val engine = o.getString("engine")
                    val ocr = NoteText.normalize(o.getString("ocrText")).text
                    val text = o.getString("text")
                    if (!SHA256_RE.matches(sha) || engine.isBlank() || text.length > NoteText.MAX_CHARS * 2) State.Idle
                    else State.Recognized(sha, engine, ocr, text, edited = text != ocr)
                }
                else -> State.Idle
            }
        } catch (e: Exception) {
            State.Idle
        }
    }

    companion object {
        const val SNAPSHOT_SCHEMA = "aihangout-camera-draft-v1"
        val SHA256_RE = Regex("^[0-9a-f]{64}$")
    }
}
