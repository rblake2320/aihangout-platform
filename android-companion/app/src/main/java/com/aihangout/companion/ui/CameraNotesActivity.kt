package com.aihangout.companion.ui

import android.content.ActivityNotFoundException
import android.os.Bundle
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import com.aihangout.companion.BuildConfig
import com.aihangout.companion.notes.CameraNote
import com.aihangout.companion.notes.CameraNoteDraft
import com.aihangout.companion.notes.MlKitTextRecognizer
import com.aihangout.companion.notes.NoteStore
import com.aihangout.companion.notes.TextRecognizer
import java.io.File
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Camera -> on-device OCR -> editable text -> explicit save -> app-private note.
 *
 * Deliberately separate from [MainActivity] (A3-owned): no shared state, no
 * token, no backend, no network import anywhere in this file. The photo is
 * taken by the system camera app (explicit shutter press by the human) into a
 * cache file exposed only through this app's FileProvider; after recognition
 * or cancel/discard the image file is deleted -- only the text is kept.
 * No CAMERA permission is declared or requested (see manifest comment).
 */
class CameraNotesActivity : AppCompatActivity() {

    private lateinit var store: NoteStore
    private lateinit var draft: CameraNoteDraft
    private lateinit var recognizer: TextRecognizer
    private lateinit var statusView: TextView
    private lateinit var textInput: EditText
    private lateinit var saveButton: Button
    private lateinit var discardButton: Button
    private lateinit var captureButton: Button
    private lateinit var notesList: LinearLayout
    private lateinit var viewer: TextView
    private var pendingImage: File? = null

    private val takePicture = registerForActivityResult(ActivityResultContracts.TakePicture()) { captured ->
        val image = pendingImage
        val sha = if (captured && image != null && image.isFile && image.length() > 0) sha256(image) else null
        draft.captureResult(captured = sha != null, imageSha256 = sha)
        if (sha == null) {
            image?.delete(); pendingImage = null
            status("Capture cancelled -- no note created.")
            render(); return@registerForActivityResult
        }
        draft.startRecognition()
        status("Recognising text on-device...")
        render()
        recognizer.recognize(image!!) { result ->
            image.delete(); pendingImage = null // photo is never retained
            result.fold(
                onSuccess = { text ->
                    draft.recognized(recognizer.engine, text)
                    val s = draft.state as CameraNoteDraft.State.Recognized
                    textInput.setText(s.text)
                    status(if (s.text.isBlank()) "No text recognised. You may type the note yourself, or discard." else "Text extracted (${s.text.length} chars). Edit it, then Save.")
                },
                onFailure = { e ->
                    draft.recognitionFailed(e.message ?: e.javaClass.simpleName)
                    status("Recognition failed -- no note created. (${e.message ?: e.javaClass.simpleName})")
                }
            )
            render()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = NoteStore(File(filesDir, "camera-notes"))
        draft = CameraNoteDraft(store)
        recognizer = MlKitTextRecognizer(this)

        captureButton = Button(this).apply { text = "Take photo of text (system camera)" }
        statusView = TextView(this).apply { text = "Idle. Photos are never uploaded or kept; only the text you save is stored on this device." }
        textInput = EditText(this).apply {
            hint = "Extracted text appears here -- edit before saving"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            minLines = 6
            isEnabled = false
        }
        saveButton = Button(this).apply { text = "Save note (explicit)"; isEnabled = false }
        discardButton = Button(this).apply { text = "Discard"; isEnabled = false }
        notesList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        viewer = TextView(this).apply { text = "" }

        captureButton.setOnClickListener { startCapture() }
        saveButton.setOnClickListener {
            draft.edit(textInput.text.toString())
            val note = draft.save(System.currentTimeMillis())
            status(if (note == null) "Not saved: the note text is blank." else "Saved note ${note.id.take(8)} (${note.text.length} chars${if (note.truncated) ", truncated" else ""}).")
            render()
        }
        discardButton.setOnClickListener {
            draft.discard()
            pendingImage?.delete(); pendingImage = null
            textInput.setText("")
            status("Discarded -- no note created.")
            render()
        }

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
            addView(TextView(this@CameraNotesActivity).apply { text = "Camera notes (on-device OCR, private)"; textSize = 18f })
            addView(captureButton)
            addView(statusView)
            addView(textInput)
            addView(saveButton)
            addView(discardButton)
            addView(TextView(this@CameraNotesActivity).apply { text = "Saved notes (newest first):"; setPadding(0, 32, 0, 8) })
            addView(notesList)
            addView(viewer)
        }
        setContentView(ScrollView(this).apply { addView(layout) })
        render()
    }

    private fun startCapture() {
        if (!draft.startCapture()) { status("Busy: finish or discard the current draft first."); return }
        val dir = File(cacheDir, "camera-notes-capture").apply { mkdirs() }
        val image = File(dir, "capture-${System.currentTimeMillis()}.jpg")
        pendingImage = image
        val uri = FileProvider.getUriForFile(this, "${BuildConfig.APPLICATION_ID}.camera-notes.fileprovider", image)
        try {
            takePicture.launch(uri)
            status("Waiting for the camera app...")
        } catch (e: ActivityNotFoundException) {
            draft.permissionDenied(); image.delete(); pendingImage = null
            status("No camera app available -- no note created.")
        } catch (e: SecurityException) {
            draft.permissionDenied(); image.delete(); pendingImage = null
            status("Camera access denied -- no note created.")
        }
        render()
    }

    private fun render() {
        val s = draft.state
        val editing = s is CameraNoteDraft.State.Recognized
        textInput.isEnabled = editing
        saveButton.isEnabled = editing
        discardButton.isEnabled = editing || s is CameraNoteDraft.State.Captured || s is CameraNoteDraft.State.Recognizing
        captureButton.isEnabled = s is CameraNoteDraft.State.Idle || s is CameraNoteDraft.State.Saved || s is CameraNoteDraft.State.NoNote
        if (s is CameraNoteDraft.State.Saved) textInput.setText("")
        renderNotes()
    }

    /** Re-read from disk every time so what is shown is exactly what survived (also after reopen). */
    private fun renderNotes() {
        notesList.removeAllViews()
        val notes = store.list()
        if (notes.isEmpty()) {
            notesList.addView(TextView(this).apply { text = "(no saved notes)" })
        }
        for (note in notes) {
            notesList.addView(Button(this).apply {
                text = "${fmt(note.createdAtEpochMs)} -- ${note.text.lineSequence().first().take(40)}"
                setOnClickListener { showNote(note) }
            })
        }
        val corrupt = store.corruptCount()
        if (corrupt > 0) notesList.addView(TextView(this).apply { text = "$corrupt unreadable note file(s) kept on disk, not shown." })
    }

    private fun showNote(note: CameraNote) {
        val fresh = store.load(note.id) ?: note
        viewer.text = "Note ${fresh.id}\nsaved ${fmt(fresh.createdAtEpochMs)} via ${fresh.ocrEngine}" +
            (fresh.sourceImageSha256?.let { "\nsource image sha256 $it" } ?: "") +
            (if (fresh.truncated) "\n(text was truncated at ${com.aihangout.companion.notes.NoteText.MAX_CHARS} chars)" else "") +
            "\n\n${fresh.text}"
    }

    private fun status(line: String) { statusView.text = line }

    private fun fmt(epochMs: Long): String = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(Date(epochMs))

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
