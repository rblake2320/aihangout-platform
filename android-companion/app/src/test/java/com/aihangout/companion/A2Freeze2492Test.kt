package com.aihangout.companion
import com.aihangout.companion.data.*
import com.aihangout.companion.net.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.MockResponse
class A2Freeze2492Test {
 private class Disk(private val dir:Path):PhaseStore {
  var refuse=false
  override fun put(key:String,value:String):Boolean {if(refuse)return false;val p=dir.resolve(key);Files.write(p,value.toByteArray(Charsets.UTF_8));FileChannel.open(p,StandardOpenOption.WRITE).use{it.force(true)};return true}
  override fun get(key:String)=dir.resolve(key).let{if(Files.exists(it))String(Files.readAllBytes(it),Charsets.UTF_8) else null}
  override fun remove(key:String):Boolean {if(refuse)return false;Files.deleteIfExists(dir.resolve(key));return true}
 }
 private fun state(phase:Phase)=JournalState(phase,"idem-A","device-A","battery_status_read","battery","owner-A","https://synthetic.invalid","action-A","read_only","digest-A","saved-output-A")
 @Test fun actualFileReopenPreservesPhasesAndRefusesWriteFailure(){
  val dir=Files.createTempDirectory("a2-2492-journal-");val store=Disk(dir);val j=ActionJournal(store,"owner-A","https://synthetic.invalid")
  store.refuse=true;assertThrows(PhaseWriteException::class.java){j.beginCreate("idem-A","device-A","battery_status_read","battery")};assertNull(j.load());store.refuse=false
  j.beginCreate("idem-A","device-A","battery_status_read","battery")
  fun reopen()=ActionJournal(Disk(dir),"owner-A","https://synthetic.invalid")
  assertEquals(ReopenDecision.Outcome.UNRESOLVED_CREATE,reopen().decide(reopen().load()!!,null).outcome)
  j.markCreated("action-A","read_only","digest-A");j.markEffectIntended()
  assertEquals(ReopenDecision.Outcome.QUARANTINE_EFFECT_UNKNOWN,reopen().decide(reopen().load()!!,null).outcome)
  j.recordOutput("exact-saved-hash");val r=reopen();val d=r.decide(r.load()!!,JSONObject().put("intent",JSONObject().put("status","approved")))
  assertEquals(ReopenDecision.Outcome.SUBMIT_SAVED_OUTPUT,d.outcome);assertEquals("exact-saved-hash",d.savedHash)
  println("A2_2492 disk=$dir create=unresolved effect=quarantine output=exact-saved-hash failed-write=refused")
 }
 @Test fun conflictingServerOutputMustNotClearSavedEvidence(){
  val rb=JSONObject().put("intent",JSONObject().put("action_id","action-A")).put("result",JSONObject().put("result_status","executed").put("result_payload_hash","different-output"))
  val d=ActionJournal.decide(state(Phase.OUTPUT_RECORDED),rb,"owner-A","https://synthetic.invalid")
  println("A2_2492 conflicting-output decision=${d.outcome}")
  assertNotEquals(ReopenDecision.Outcome.RECONCILE_RESULT_PRESENT,d.outcome)
 }
 @Test fun recordsKnownTerminalOutputResidual(){
  val rb=JSONObject().put("intent",JSONObject().put("action_id","action-A").put("status","revoked"))
  val d=ActionJournal.decide(state(Phase.OUTPUT_RECORDED),rb,"owner-A","https://synthetic.invalid")
  assertEquals(ReopenDecision.Outcome.TERMINAL_OUTPUT_BLOCKED,d.outcome);assertNull(d.savedHash)
  println("A2_2492 known revoked-output residual=${d.outcome}")
 }
 @Test fun malformedEnrollmentReplyMustRemainUnknown(){
  val s=MockWebServer();s.start();try {s.enqueue(MockResponse().setResponseCode(200).setBody("not-json"));val api=AihangoutApi(s.url("/").toString().trimEnd('/'))
   val e=assertThrows(Exception::class.java){api.enroll("synthetic","agent","spki","com.test","cert","challenge","signature")}
   println("A2_2492 malformed-enroll classified=${e.javaClass.simpleName}; MainActivity clears lock for AihangoutApiException")
   assertFalse("Malformed post-write response cannot be routed to the clear-lock HTTP-refusal catch",e is AihangoutApiException)
  }finally{s.shutdown()}
 }
}

