package com.aihangout.companion.watch

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject
import java.util.UUID

data class WatchEvent(val id: String, val source: String, val title: String, val text: String, val time: Long)
data class WatchRequest(val id: String, val eventId: String, val deviceId: String, val state: String, val response: String?)

/** App-private SQLite journal; no public feed and no automatic retry worker. */
class WatchStore(context: Context) : SQLiteOpenHelper(context.applicationContext, "camera_watch.db", null, 1) {
    companion object { private val PROCESS = UUID.randomUUID().toString() }
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE events(id TEXT PRIMARY KEY, dedup TEXT UNIQUE NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, observed INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE requests(id TEXT PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, device_id TEXT NOT NULL, state TEXT NOT NULL, process TEXT NOT NULL, response TEXT, receipt TEXT)")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = error("Unsupported camera watch schema upgrade")
    @Synchronized fun recover() {
        writableDatabase.execSQL("UPDATE requests SET state='UNKNOWN' WHERE state IN ('SENDING','ACTING') AND process<>?", arrayOf(PROCESS))
    }
    @Synchronized fun event(source: String, key: String, posted: Long, title: String, text: String): String {
        require(source in setOf(WatchProtocol.BLINK_SOURCE,"phone_camera","shared_image"))
        require(key.length <= 2048 && posted > 0)
        val dedup = JSONObject().put("key", key).put("postTime", posted).toString()
        readableDatabase.rawQuery("SELECT id FROM events WHERE dedup=?",arrayOf(dedup)).use { if(it.moveToFirst()) return it.getString(0) }
        // Finite local collection. Never delete an event carrying an analysis/action journal.
        writableDatabase.execSQL("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE id NOT IN (SELECT event_id FROM requests) ORDER BY observed ASC LIMIT MAX(0,(SELECT COUNT(*) FROM events)-499))")
        readableDatabase.rawQuery("SELECT COUNT(*) FROM events",null).use { check(it.moveToFirst()); check(it.getInt(0)<500) { "Camera event storage full; existing request evidence retained" } }
        val id = UUID.randomUUID().toString()
        val values = ContentValues().apply {
            put("id", id); put("dedup", dedup); put("source", source)
            put("title", title.take(300)); put("body", text.take(2000)); put("observed", posted)
        }
        writableDatabase.insertWithOnConflict("events", null, values, SQLiteDatabase.CONFLICT_IGNORE)
        return readableDatabase.rawQuery("SELECT id FROM events WHERE dedup=?", arrayOf(dedup)).use { check(it.moveToFirst()); it.getString(0) }
    }
    fun events(): List<WatchEvent> = readableDatabase.rawQuery("SELECT id,source,title,body,observed FROM events ORDER BY observed DESC LIMIT 100", null).use { c ->
        buildList { while (c.moveToNext()) add(WatchEvent(c.getString(0),c.getString(1),c.getString(2),c.getString(3),c.getLong(4))) }
    }
    fun request(eventId: String): WatchRequest? = readableDatabase.rawQuery("SELECT id,event_id,device_id,state,response FROM requests WHERE event_id=?", arrayOf(eventId)).use { c ->
        if (!c.moveToFirst()) null else WatchRequest(c.getString(0),c.getString(1),c.getString(2),c.getString(3),if(c.isNull(4)) null else c.getString(4))
    }
    @Synchronized fun begin(eventId: String, deviceId: String): WatchRequest {
        require(deviceId.isNotBlank())
        val id = UUID.randomUUID().toString()
        val values = ContentValues().apply { put("id",id); put("event_id",eventId); put("device_id",deviceId); put("state","SENDING"); put("process",PROCESS) }
        writableDatabase.insertOrThrow("requests", null, values)
        return request(eventId)!!
    }
    @Synchronized fun analyzed(request: WatchRequest, response: String) {
        WatchProtocol.parse(response,request.id,request.eventId)
        val values = ContentValues().apply { put("state","ANALYZED"); put("response",response) }
        check(writableDatabase.update("requests",values,"id=? AND state IN ('SENDING','UNKNOWN') AND receipt IS NULL",arrayOf(request.id)) == 1) { "Analysis journal state mismatch" }
    }
    @Synchronized fun reconcile(request: WatchRequest, response: String) {
        val state=WatchProtocol.reconciledState(response,request.id,request.eventId)
        val values=ContentValues().apply { put("state",state); put("response",response) }
        check(writableDatabase.update("requests",values,"id=? AND state='UNKNOWN' AND receipt IS NULL",arrayOf(request.id))==1) { "Reconciliation cannot replace a claimed action" }
    }
    @Synchronized fun unknown(request: WatchRequest) {
        writableDatabase.execSQL("UPDATE requests SET state='UNKNOWN' WHERE id=? AND state IN ('SENDING','ACTING')",arrayOf(request.id))
    }
    @Synchronized fun claimAction(request: WatchRequest) {
        val intent = JSONObject().put("operation",WatchProtocol.CHECKIN).put("approvedAt",System.currentTimeMillis()).put("requestId",request.id).put("eventId",request.eventId).put("status","INTENT").toString()
        val values = ContentValues().apply { put("state","ACTING"); put("process",PROCESS); put("receipt",intent) }
        check(writableDatabase.update("requests",values,"id=? AND state='ANALYZED' AND receipt IS NULL",arrayOf(request.id))==1) { "Action already claimed or unavailable" }
    }
    @Synchronized fun finishAction(request: WatchRequest, visible: Boolean) {
        val intent = readableDatabase.rawQuery("SELECT receipt FROM requests WHERE id=? AND state='ACTING'",arrayOf(request.id)).use { c -> check(c.moveToFirst()); JSONObject(c.getString(0)) }
        check(intent.getString("requestId")==request.id && intent.getString("eventId")==request.eventId && intent.has("approvedAt"))
        val receipt = intent.put("finishedAt",System.currentTimeMillis()).put("notificationPresent",visible).put("status",if(visible) "OBSERVED" else "UNKNOWN").toString()
        val values = ContentValues().apply { put("state",if(visible) "COMPLETED" else "UNKNOWN"); put("receipt",receipt) }
        check(writableDatabase.update("requests",values,"id=? AND state='ACTING'",arrayOf(request.id))==1)
    }
}
