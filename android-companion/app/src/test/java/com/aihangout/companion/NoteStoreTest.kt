package com.aihangout.companion

import com.aihangout.companion.notes.NoteStore
import com.aihangout.companion.notes.NoteText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class NoteStoreTest {

    private fun tempDir(): File = Files.createTempDirectory("camera-notes-test").toFile()

    @Test
    fun `a saved note survives a fresh store instance (reopen) with the same text and provenance`() {
        val dir = tempDir()
        val saved = NoteStore(dir).save("Line one\r\nLine two  ", "ab".repeat(32), "fake-ocr", 1_700_000_000_000L)
        assertNotNull(saved)
        val reopened = NoteStore(dir) // new instance = app reopened
        val listed = reopened.list()
        assertEquals(1, listed.size)
        assertEquals("Line one\nLine two", listed[0].text)
        assertEquals("ab".repeat(32), listed[0].sourceImageSha256)
        assertEquals("fake-ocr", listed[0].ocrEngine)
        assertEquals(saved!!.id, listed[0].id)
        assertEquals(listed[0], reopened.load(saved.id))
    }

    @Test
    fun `blank text is refused and nothing is written`() {
        val dir = tempDir()
        val store = NoteStore(dir)
        assertNull(store.save("   \n\t  ", null, "fake-ocr", 1L))
        assertEquals(0, dir.listFiles()?.size ?: 0)
        assertTrue(store.list().isEmpty())
    }

    @Test
    fun `list is newest first and skips a corrupt file without deleting it`() {
        val dir = tempDir()
        val store = NoteStore(dir)
        store.save("older", null, "fake-ocr", 100L)
        store.save("newer", null, "fake-ocr", 200L)
        val corrupt = File(dir, "not-a-note.json").apply { writeText("{\"schema\":\"garbage\"") }
        val notes = store.list()
        assertEquals(listOf("newer", "older"), notes.map { it.text })
        assertTrue(corrupt.exists())
        assertEquals(1, store.corruptCount())
    }

    @Test
    fun `a note file whose name does not match its id is not trusted`() {
        val dir = tempDir()
        val store = NoteStore(dir)
        val note = store.save("real", null, "fake-ocr", 1L)!!
        val copied = File(dir, "11111111-1111-1111-1111-111111111111.json")
        File(dir, "${note.id}.json").copyTo(copied)
        assertEquals(1, store.list().size)
        assertNull(store.load("11111111-1111-1111-1111-111111111111"))
    }

    @Test
    fun `load never builds a path from an unvalidated id`() {
        val store = NoteStore(tempDir())
        assertNull(store.load("../../etc/passwd"))
        assertNull(store.load("..\\x.json"))
    }

    @Test
    fun `an oversized note is bounded and flagged as truncated`() {
        val store = NoteStore(tempDir())
        val note = store.save("y".repeat(NoteText.MAX_CHARS + 500), null, "fake-ocr", 1L)!!
        assertEquals(NoteText.MAX_CHARS, note.text.length)
        assertTrue(note.truncated)
        assertTrue(store.load(note.id)!!.truncated)
    }

    @Test
    fun `no temp file is left behind after a save`() {
        val dir = tempDir()
        NoteStore(dir).save("x", null, "fake-ocr", 1L)
        assertTrue(dir.listFiles()!!.none { it.name.endsWith(".tmp") })
    }
}
