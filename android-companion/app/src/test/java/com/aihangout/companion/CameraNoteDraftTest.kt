package com.aihangout.companion

import com.aihangout.companion.notes.CameraNoteDraft
import com.aihangout.companion.notes.CameraNoteDraft.State
import com.aihangout.companion.notes.NoteStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class CameraNoteDraftTest {

    private val sha = "cd".repeat(32)
    private fun fixture(): Pair<CameraNoteDraft, File> {
        val dir = Files.createTempDirectory("camera-draft-test").toFile()
        return CameraNoteDraft(NoteStore(dir)) to dir
    }
    private fun noteFiles(dir: File) = dir.listFiles()?.filter { it.name.endsWith(".json") } ?: emptyList()

    @Test
    fun `cancelled capture produces no note and save is refused`() {
        val (draft, dir) = fixture()
        assertTrue(draft.startCapture())
        draft.captureResult(captured = false, imageSha256 = null)
        assertTrue(draft.state is State.NoNote)
        assertNull(draft.save(1L))
        assertEquals(0, noteFiles(dir).size)
    }

    @Test
    fun `permission denial produces no note and save is refused`() {
        val (draft, dir) = fixture()
        assertTrue(draft.startCapture())
        draft.permissionDenied()
        assertTrue(draft.state is State.NoNote)
        assertFalse(draft.edit("typed anyway"))
        assertNull(draft.save(1L))
        assertEquals(0, noteFiles(dir).size)
    }

    @Test
    fun `recognition failure produces no note`() {
        val (draft, dir) = fixture()
        draft.startCapture(); draft.captureResult(true, sha); draft.startRecognition()
        draft.recognitionFailed("engine error")
        assertTrue(draft.state is State.NoNote)
        assertNull(draft.save(1L))
        assertEquals(0, noteFiles(dir).size)
    }

    @Test
    fun `the saved note is the human's edited text, not the raw OCR output, and carries provenance`() {
        val (draft, dir) = fixture()
        draft.startCapture(); draft.captureResult(true, sha); draft.startRecognition()
        draft.recognized("fake-ocr", "MILK\nEGGS\nBRAED")
        assertTrue(draft.edit("MILK\nEGGS\nBREAD"))
        val note = draft.save(42L)
        assertNotNull(note)
        assertEquals("MILK\nEGGS\nBREAD", note!!.text)
        assertEquals(sha, note.sourceImageSha256)
        assertEquals("fake-ocr", note.ocrEngine)
        assertEquals(42L, note.createdAtEpochMs)
        assertTrue(draft.state is State.Saved)
        assertEquals(1, noteFiles(dir).size)
        assertEquals("MILK\nEGGS\nBREAD", NoteStore(dir).list()[0].text) // durable, readable after reopen
    }

    @Test
    fun `OCR text is never saved automatically -- only an explicit save writes`() {
        val (draft, dir) = fixture()
        draft.startCapture(); draft.captureResult(true, sha); draft.startRecognition()
        draft.recognized("fake-ocr", "some text")
        assertEquals(0, noteFiles(dir).size)
        draft.discard()
        assertTrue(draft.state is State.NoNote)
        assertNull(draft.save(1L))
        assertEquals(0, noteFiles(dir).size)
    }

    @Test
    fun `blank recognised text cannot be saved until the human types something`() {
        val (draft, dir) = fixture()
        draft.startCapture(); draft.captureResult(true, sha); draft.startRecognition()
        draft.recognized("fake-ocr", "   \n  ")
        assertNull(draft.save(1L))
        assertEquals(0, noteFiles(dir).size)
        draft.edit("typed by hand")
        assertNotNull(draft.save(1L))
        assertEquals(1, noteFiles(dir).size)
    }

    @Test
    fun `a note cannot be saved twice and a second capture cannot start mid-draft`() {
        val (draft, dir) = fixture()
        draft.startCapture(); draft.captureResult(true, sha); draft.startRecognition()
        assertFalse(draft.startCapture()) // busy: recognising
        draft.recognized("fake-ocr", "text")
        assertFalse(draft.startCapture()) // busy: editing
        assertNotNull(draft.save(1L))
        assertNull(draft.save(2L))
        assertEquals(1, noteFiles(dir).size)
        draft.discard() // discarding the screen after a save does not un-save
        assertTrue(draft.state is State.Saved)
        assertTrue(draft.startCapture())
    }

    @Test
    fun `captured with a missing hash counts as no capture`() {
        val (draft, dir) = fixture()
        draft.startCapture()
        draft.captureResult(captured = true, imageSha256 = null)
        assertTrue(draft.state is State.NoNote)
        assertEquals(0, noteFiles(dir).size)
    }
}
