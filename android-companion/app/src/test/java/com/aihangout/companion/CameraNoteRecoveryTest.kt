package com.aihangout.companion

import com.aihangout.companion.notes.CameraNoteDraft
import com.aihangout.companion.notes.CameraNoteDraft.State
import com.aihangout.companion.notes.NoteStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * Recreation / process-death review (A1 closure check on e1bebdc). These are
 * the rules the Activity relies on when Android rebuilds it while the camera
 * app is in front or while the human is editing.
 */
class CameraNoteRecoveryTest {

    private val sha = "ef".repeat(32)
    private fun dir(): File = Files.createTempDirectory("camera-recovery-test").toFile()

    @Test
    fun `process death while the camera app is open - a restored AwaitingCapture draft accepts the delivered result`() {
        val d = dir()
        val before = CameraNoteDraft(NoteStore(d)); before.startCapture()
        val json = before.snapshot() // what onSaveInstanceState stores

        val after = CameraNoteDraft(NoteStore(d)) // fresh process
        after.restore(json)
        assertTrue(after.state is State.AwaitingCapture)
        after.captureResult(captured = true, imageSha256 = sha) // no IllegalStateException (the e1bebdc crash)
        assertTrue(after.state is State.Captured)
        assertEquals(sha, (after.state as State.Captured).imageSha256) // hash binding survives recreation
    }

    @Test
    fun `without a restore, the delivered result would hit Idle - the Activity's fallback makes it AwaitingCapture first`() {
        val fresh = CameraNoteDraft(NoteStore(dir()))
        assertTrue(fresh.state is State.Idle)
        val threw = try { fresh.captureResult(true, sha); false } catch (e: IllegalStateException) { true }
        assertTrue("e1bebdc defect reproduced: result in Idle throws", threw)
        fresh.restore("{\"schema\":\"${CameraNoteDraft.SNAPSHOT_SCHEMA}\",\"kind\":\"awaiting\"}")
        fresh.captureResult(true, sha)
        assertTrue(fresh.state is State.Captured)
    }

    @Test
    fun `rotation while editing keeps the human's edits and the provenance, and save still works`() {
        val d = dir()
        val before = CameraNoteDraft(NoteStore(d))
        before.startCapture(); before.captureResult(true, sha); before.startRecognition()
        before.recognized("fake-ocr", "RAW OCR")
        before.edit("edited by the human")
        val json = before.snapshot()

        val after = CameraNoteDraft(NoteStore(d)); after.restore(json)
        val s = after.state as State.Recognized
        assertEquals("edited by the human", s.text)
        assertEquals("RAW OCR", s.ocrText)
        assertTrue(s.edited)
        assertEquals(sha, s.imageSha256)
        val note = after.save(7L)
        assertNotNull(note)
        assertEquals("edited by the human", NoteStore(d).list()[0].text)
        assertEquals(sha, note!!.sourceImageSha256)
    }

    @Test
    fun `a saved or no-note state is not resurrected - restore yields Idle and nothing is written`() {
        val d = dir()
        val before = CameraNoteDraft(NoteStore(d))
        before.startCapture(); before.captureResult(false, null)
        val after = CameraNoteDraft(NoteStore(d)); after.restore(before.snapshot())
        assertTrue(after.state is State.Idle)
        assertNull(after.save(1L))
        assertEquals(0, d.listFiles()!!.count { it.name.endsWith(".json") })
    }

    @Test
    fun `malformed or hostile snapshots are contained as Idle, never an exception`() {
        val d = CameraNoteDraft(NoteStore(dir()))
        for (bad in listOf(null, "", "not json", "[]", "{\"schema\":\"other\"}",
            "{\"schema\":\"${CameraNoteDraft.SNAPSHOT_SCHEMA}\",\"kind\":\"recognized\"}",
            "{\"schema\":\"${CameraNoteDraft.SNAPSHOT_SCHEMA}\",\"kind\":\"recognized\",\"sha\":\"../x\",\"engine\":\"e\",\"ocrText\":\"a\",\"text\":\"a\"}",
            "{\"schema\":\"${CameraNoteDraft.SNAPSHOT_SCHEMA}\",\"kind\":\"recognized\",\"sha\":\"$sha\",\"engine\":\"\",\"ocrText\":\"a\",\"text\":\"a\"}")) {
            d.restore(bad)
            assertTrue("input: $bad", d.state is State.Idle)
        }
    }

    @Test
    fun `a failed save keeps the draft (still Recognized, edits intact) and a later retry succeeds`() {
        val d = dir()
        var renameWorks = false
        val store = NoteStore(d, rename = { from, to -> renameWorks && from.renameTo(to) })
        val draft = CameraNoteDraft(store)
        draft.startCapture(); draft.captureResult(true, sha); draft.startRecognition()
        draft.recognized("fake-ocr", "RAW"); draft.edit("edited")
        val thrown = try { draft.save(1L); null } catch (e: com.aihangout.companion.notes.NoteWriteException) { e }
        assertNotNull(thrown)
        val s = draft.state as State.Recognized // NOT Saved, NOT NoNote
        assertEquals("edited", s.text)
        assertTrue(store.list().isEmpty())
        renameWorks = true
        store.sweepStaleTemp()
        val note = draft.save(2L)
        assertNotNull(note)
        assertEquals("edited", store.load(note!!.id)!!.text)
        assertTrue(draft.state is State.Saved)
    }

    @Test
    fun `an interrupted save leaves only a temp file that is never listed and is swept, while real notes stay`() {
        val d = dir()
        val store = NoteStore(d)
        val real = store.save("kept", null, "fake-ocr", 1L)!!
        File(d, "22222222-2222-2222-2222-222222222222.json.tmp").writeText("{\"partial\":") // crash mid-write
        assertEquals(listOf(real.id), store.list().map { it.id })
        assertEquals(1, store.sweepStaleTemp())
        assertEquals(0, store.sweepStaleTemp())
        assertEquals(listOf(real.id), store.list().map { it.id })
        assertTrue(File(d, "${real.id}.json").isFile)
    }
}
