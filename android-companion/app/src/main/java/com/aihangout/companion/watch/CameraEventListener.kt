package com.aihangout.companion.watch

import android.app.Notification
import android.content.ComponentName
import android.content.Intent
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

/** Only observed Blink motion notifications. No upload and no automatic action. */
class CameraEventListener : NotificationListenerService() {
    companion object { const val LOCAL_CHANGED="com.aihangout.companion.CAMERA_WATCH_LOCAL_CHANGED" }
    override fun onListenerConnected() {
        health("connected")
        try { activeNotifications?.forEach { collect(it) } }
        catch(e: Exception) { health("active-notification-read-failed") }
    }
    override fun onListenerDisconnected() {
        health("disconnected")
        requestRebind(ComponentName(this,CameraEventListener::class.java))
    }
    override fun onNotificationPosted(sbn: StatusBarNotification?) { if(sbn!=null) collect(sbn) }
    private fun changed() { sendBroadcast(Intent(LOCAL_CHANGED).setPackage(packageName)) }
    private fun health(value: String) {
        if(getSharedPreferences("camera-watch-health",MODE_PRIVATE).edit().putString("state",value).putLong("observed",System.currentTimeMillis()).commit()) changed()
        else Log.e("CameraWatch","Listener health persistence failed")
    }
    private fun collect(sbn: StatusBarNotification) {
        if(!WatchProtocol.acceptsPackage(sbn.packageName)) return
        val age=System.currentTimeMillis()-sbn.postTime
        if(age !in -30000..600000) return
        try {
            val extras=sbn.notification.extras
            val title=extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
            val text=(extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?:extras.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty()
            if(!WatchProtocol.acceptsMotion(sbn.packageName,title,text,sbn.postTime,System.currentTimeMillis())) return
            WatchStore(this).use { it.event(WatchProtocol.BLINK_SOURCE,sbn.key,sbn.postTime,title,text) }
            changed()
        } catch(e: Exception) { health("event-save-failed"); Log.e("CameraWatch","Local event failed: ${e.javaClass.simpleName}") }
    }
}
