package com.aihangout.companion.ui

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Base64
import android.view.MotionEvent
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import androidx.core.content.ContextCompat
import com.aihangout.companion.BuildConfig
import com.aihangout.companion.data.DeviceBinding
import com.aihangout.companion.data.TokenStore
import com.aihangout.companion.watch.*
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors

/** Explicit private upload -> advice -> separate human approval -> local notification. */
class CameraWatchActivity : AppCompatActivity() {
    companion object { private val worker = Executors.newSingleThreadExecutor(); private const val CHANNEL="camera-watch-checkin" }
    private lateinit var store: WatchStore
    private lateinit var tokens: TokenStore
    private lateinit var column: LinearLayout
    private lateinit var status: TextView
    private lateinit var scroll: ScrollView
    private var selected: String?=null
    private var pendingCapture: String?=null
    private var photo: ByteArray?=null
    private var busy=false
    private var touching=false
    private var refreshPending=false
    private var receiverRegistered=false
    private val localChangeReceiver=object: BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if(intent?.action==CameraEventListener.LOCAL_CHANGED) refreshFromLocalState()
        }
    }
    private val api=WatchApi(BuildConfig.AIHANGOUT_BASE_URL)
    private val permission=registerForActivityResult(ActivityResultContracts.RequestPermission()) { render() }
    private val pick=registerForActivityResult(ActivityResultContracts.GetContent()) { uri -> if(uri!=null) guard { acceptImage(uri,"shared_image") } }
    private val capture=registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        guard {
            val path=pendingCapture; pendingCapture=null
            if(path!=null) {
                val file=File(cacheDir,"watch-capture/$path")
                try { if(ok) acceptImage(Uri.fromFile(file),"phone_camera") } finally { file.delete() }
            }
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        column=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; setPadding(20,20,20,20) }
        status=TextView(this)
        scroll=ScrollView(this).apply { addView(column) }
        setContentView(scroll)
        guard {
            store=WatchStore(this); tokens=TokenStore(this); store.recover()
            selected=savedInstanceState?.getString("event")
            pendingCapture=savedInstanceState?.getString("capture")?.takeIf { it.matches(Regex("watch-[a-f0-9-]+\\.jpg")) }
            WatchRecovery.sweepCaptures(File(cacheDir,"watch-capture"),pendingCapture)
            render()
        }
    }
    override fun onStart() {
        super.onStart()
        ContextCompat.registerReceiver(this,localChangeReceiver,IntentFilter(CameraEventListener.LOCAL_CHANGED),ContextCompat.RECEIVER_NOT_EXPORTED)
        receiverRegistered=true
    }
    override fun onResume() { super.onResume(); refreshFromLocalState() }
    override fun onStop() {
        if(receiverRegistered) { unregisterReceiver(localChangeReceiver); receiverRegistered=false }
        super.onStop()
    }
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if(event.actionMasked==MotionEvent.ACTION_DOWN) touching=true
        val handled=super.dispatchTouchEvent(event)
        if(event.actionMasked==MotionEvent.ACTION_UP||event.actionMasked==MotionEvent.ACTION_CANCEL) {
            touching=false
            if(refreshPending) column.post { if(receiverRegistered) refreshFromLocalState() }
        }
        return handled
    }
    /** Observes local persistence only. No network, action or automatic retry. */
    private fun refreshFromLocalState() {
        if(!::store.isInitialized||!::tokens.isInitialized) return
        if(touching||busy) { refreshPending=true; return }
        refreshPending=false
        val scrollY=scroll.scrollY
        guard { render() }
        scroll.post { if(!isDestroyed) scroll.scrollTo(0,scrollY) }
    }
    override fun onSaveInstanceState(out: Bundle) { out.putString("event",selected); out.putString("capture",pendingCapture); super.onSaveInstanceState(out) }
    private fun guard(body:()->Unit) { try { body() } catch(e: Exception) { status.text="Stopped: ${e.message ?: e.javaClass.simpleName}"; if(status.parent==null) column.addView(status) } }
    private fun button(label: String, enabled: Boolean=true, action:()->Unit) { column.addView(Button(this).apply { text=label; isEnabled=enabled&&!busy; setOnClickListener { guard(action) } }) }
    private fun render() {
        refreshPending=false
        column.removeAllViews()
        column.addView(TextView(this).apply { text="Camera check-in\nBlink motion events stay on this phone until you explicitly send one. AI analysis may be wrong. This is not fall, fire, medication or emergency monitoring." })
        val health=getSharedPreferences("camera-watch-health",MODE_PRIVATE).getString("state","not connected")
        column.addView(TextView(this).apply { text="Notification listener: $health. Collection currently recognizes English 'motion' notifications only." })
        column.addView(TextView(this).apply { text="Android notification access is a broad system grant. This app filters and saves only fresh Blink motion notifications; other apps are ignored." })
        button("Open notification access settings") { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
        button("Allow local check-in notifications") { if(Build.VERSION.SDK_INT>=33) permission.launch(Manifest.permission.POST_NOTIFICATIONS) else startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,packageName)) }
        button("Refresh local events") { render() }
        button("Choose photo") { pick.launch("image/*") }
        button("Take photo") {
            val dir=File(cacheDir,"watch-capture"); check(dir.isDirectory||dir.mkdirs())
            val file=File(dir,"watch-${UUID.randomUUID()}.jpg"); pendingCapture=file.name
            capture.launch(FileProvider.getUriForFile(this,"${BuildConfig.APPLICATION_ID}.camera-notes.fileprovider",file))
        }
        val events=store.events()
        val event=events.firstOrNull { it.id==selected }
        if(event!=null) {
            column.addView(TextView(this).apply { text="${event.title}\n${event.text}\nObserved: ${java.util.Date(event.time)}\nPhoto selected: ${photo!=null}" })
            val request=store.request(event.id)
            column.addView(TextView(this).apply { text="Request: ${request?.state ?: "not sent"}" })
            if(request==null) {
                column.addView(TextView(this).apply { text="Sending shares this selected event and optional photo privately with ${BuildConfig.AIHANGOUT_BASE_URL} and its AI provider. It is not posted to AIHangout's public feed. Only send content you are authorized to share." })
                button("Send this event/photo for AI analysis",event.source==WatchProtocol.BLINK_SOURCE||photo!=null) { send(event) }
            } else {
                if(request.state=="FAILED") column.addView(TextView(this).apply { text="Analysis failed. No check-in is authorized; this request will not be resent." })
                request.response?.takeIf { request.state in setOf("ANALYZED","ACTING","COMPLETED") }?.let { raw -> val analysis=WatchProtocol.parse(raw,request.id,event.id); column.addView(TextView(this).apply { text=analysis.summary })
                    if(request.state=="ANALYZED"&&analysis.proposalText!=null) button("Approve local check-in") { approve(request) }
                }
                if(request.state=="UNKNOWN") button("Reconcile existing request (GET only)") { reconcile(request) }
            }
        }
        column.addView(status)
        column.addView(TextView(this).apply { text="Recent events — select one to review above" })
        val eventTime=java.text.SimpleDateFormat("MMM d, HH:mm:ss",java.util.Locale.getDefault())
        for(item in events) button("${if(selected==item.id) "Selected: " else ""}${eventTime.format(java.util.Date(item.time))} — ${item.title.take(80)} (${item.source})") {
            if(selected!=item.id) photo=null
            selected=item.id
            render()
            scroll.post { scroll.scrollTo(0,0) }
        }
    }
    private fun acceptImage(uri: Uri, source: String) {
        val bounds=BitmapFactory.Options().apply { inJustDecodeBounds=true }
        contentResolver.openInputStream(uri).use { checkNotNull(it); BitmapFactory.decodeStream(it,null,bounds) }
        require(bounds.outWidth>0&&bounds.outHeight>0&&bounds.outWidth<=50000&&bounds.outHeight<=50000) { "Unreadable or excessive image dimensions" }
        var sample=1
        while(bounds.outWidth/sample>1024||bounds.outHeight/sample>1024) sample*=2
        val bitmap=contentResolver.openInputStream(uri).use { checkNotNull(it); BitmapFactory.decodeStream(it,null,BitmapFactory.Options().apply { inSampleSize=sample }) } ?: error("Cannot decode selected image")
        val bytes=try { ByteArrayOutputStream().use { out -> check(bitmap.compress(Bitmap.CompressFormat.JPEG,75,out)); out.toByteArray() } } finally { bitmap.recycle() }
        require(bytes.size in 1..524288) { "Photo must encode below 512 KiB" }
        // Fresh JPEG encoding strips source EXIF rather than forwarding location/metadata.
        selected=store.event(source,UUID.randomUUID().toString(),System.currentTimeMillis(),"Selected camera photo","")
        photo=bytes; status.text="Photo prepared locally; no upload has occurred."; render()
    }
    private fun background(work:()->Unit) {
        busy=true; render()
        worker.execute {
            val message=try { work(); "Result saved locally." } catch(e:Exception) { "Stopped: ${e.message ?: e.javaClass.simpleName}. Unknown actions are never automatically replayed." }
            runOnUiThread { if(!isDestroyed) { busy=false; status.text=message; guard { render() } } }
        }
    }
    private fun identity(): Pair<String,String> {
        val jwt=tokens.jwt?.takeIf { it.isNotBlank() } ?: error("Sign in and enroll first")
        val owner=api.owner(jwt)
        val resolved=DeviceBinding(tokens.phaseStore).resolve(owner,BuildConfig.AIHANGOUT_BASE_URL,tokens.deviceId)
        require(resolved is DeviceBinding.Resolution.Bound) { "Current owner/backend enrollment is not bound" }
        check(tokens.jwt==jwt) { "Account changed during request" }
        return jwt to resolved.deviceId
    }
    private fun send(event: WatchEvent) {
        val image=photo?.clone()
        require(event.source==WatchProtocol.BLINK_SOURCE||image!=null) { "Select the photo again before sending" }
        require(System.currentTimeMillis()-event.time in -30000..600000) { "Event is older than ten minutes; choose a fresh observation" }
        background {
            val (jwt,device)=identity()
            val request=store.begin(event.id,device)
            try {
                val body=JSONObject().put("requestId",request.id).put("eventId",event.id).put("deviceId",device).put("consent",true)
                    .put("event",JSONObject().put("source",event.source).put("title",event.title).put("text",event.text).put("observedAt",event.time))
                if(image!=null) body.put("imageBase64",Base64.encodeToString(image,Base64.NO_WRAP)).put("imageSha256",MessageDigest.getInstance("SHA-256").digest(image).joinToString("") { "%02x".format(it) })
                val response=api.analyze(jwt,body)
                store.analyzed(request,response)
            } catch(e: Exception) { store.unknown(request); throw e }
        }
    }
    private fun reconcile(request: WatchRequest) = background {
        val (jwt,device)=identity(); require(device==request.deviceId) { "Device binding changed" }
        store.reconcile(request,api.reconcile(jwt,request.id))
    }
    private fun approve(request: WatchRequest) {
        val manager=getSystemService(NotificationManager::class.java)
        require(manager.areNotificationsEnabled()) { "Allow local notifications first" }
        manager.createNotificationChannel(NotificationChannel(CHANNEL,"Camera check-in",NotificationManager.IMPORTANCE_DEFAULT).apply { setSound(null,null); enableVibration(false) })
        require(manager.getNotificationChannel(CHANNEL).importance!=NotificationManager.IMPORTANCE_NONE) { "Camera check-in channel is disabled" }
        background {
            val (_,device)=identity(); require(device==request.deviceId) { "Device binding changed" }
            val current=store.request(request.eventId) ?: error("Missing durable request")
            val analysis=WatchProtocol.parse(checkNotNull(current.response),current.id,current.eventId)
            require(analysis.proposalText==WatchProtocol.CHECKIN_TEXT)
            store.claimAction(current)
            try {
                manager.notify(current.id,1,NotificationCompat.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("Camera check-in").setContentText(WatchProtocol.CHECKIN_TEXT).setSilent(true).setAutoCancel(true).build())
                val visible=WatchRecovery.awaitVisible(android.os.SystemClock::elapsedRealtime,{ Thread.sleep(it) }) {
                    manager.activeNotifications.any { it.tag==current.id && it.id==1 && it.notification.extras.getCharSequence(android.app.Notification.EXTRA_TEXT)?.toString()==WatchProtocol.CHECKIN_TEXT }
                }
                store.finishAction(current,visible)
            } catch(e:Exception) { store.unknown(current); throw e }
        }
    }
}
