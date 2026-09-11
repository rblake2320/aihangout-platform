package com.aihangout.companion.ui

import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.aihangout.companion.skills.BundledSkillLoader
import com.aihangout.companion.skills.LoadedSkill
import com.aihangout.companion.skills.SkillVerdict

/**
 * Guided procedure discovery. Lists the procedures bundled in this APK, shows
 * each one's provenance, verification metadata and its full procedure text as
 * PLAIN TEXT, and offers exactly one action per supported skill: opening the
 * already-existing local screen the registry maps it to -- only after an
 * explicit tap, only when the skill's verification metadata matches THIS
 * installed build. Refused or unverified skills are shown with the reason and
 * have no action. Nothing here talks to the network, runs code from a file, or
 * bypasses the web-approval / digest / explicit-save gates of the screens it
 * opens. Separate from MainActivity (A3/A1-owned).
 */
class SkillsActivity : AppCompatActivity() {

    private lateinit var list: LinearLayout
    private lateinit var detail: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val loader = BundledSkillLoader(this)
        val installed = loader.installedIdentity()
        val skills = loader.load()

        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        detail = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 32, 0, 0) }

        val header = TextView(this).apply {
            textSize = 18f
            text = "Bundled procedures (${skills.count { it is LoadedSkill.Supported }} supported, " +
                "${skills.count { it is LoadedSkill.Refused }} refused)\n" +
                "This build: v${installed.appVersion}, signer ${installed.signerSha256?.take(12) ?: "unknown"}…, apk ${installed.apkSha256?.take(12) ?: "unknown"}…"
        }
        for (s in skills) list.addView(row(s))

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
            addView(header)
            addView(TextView(this@SkillsActivity).apply { text = "A procedure file describes steps; it grants no authority. Only listed, verified entries can be opened, and only to screens that exist in this app."; setPadding(0, 16, 0, 16) })
            addView(list)
            addView(detail)
        }
        setContentView(ScrollView(this).apply { addView(layout) })
    }

    private fun row(s: LoadedSkill): Button = Button(this).apply {
        text = when (s) {
            is LoadedSkill.Supported -> "${s.manifest.name} -- ${if (s.dispatchAllowed) "VERIFIED for this build" else "UNVERIFIED (revalidation required)"}"
            is LoadedSkill.Refused -> "${s.directory} -- REFUSED"
        }
        setOnClickListener { show(s) }
    }

    private fun show(s: LoadedSkill) {
        detail.removeAllViews()
        when (s) {
            is LoadedSkill.Refused -> {
                detail.addView(TextView(this).apply { text = "REFUSED: ${s.reason}\nNo action is available for this entry." })
                s.manifest?.let { m -> detail.addView(TextView(this).apply { text = "\n(declared operation '${m.operationReference}', provenance: ${m.provenance})" }) }
            }
            is LoadedSkill.Supported -> {
                val m = s.manifest
                val verdictText = when (val v = s.verdict) {
                    is SkillVerdict.Verified -> "VERIFIED: version and artifact identity match this installed build."
                    is SkillVerdict.Unverified -> "UNVERIFIED for this build -- ${v.reasons.joinToString("; ")}. The procedure's own rule: revalidate before use. Dispatch is disabled."
                }
                detail.addView(TextView(this).apply {
                    textSize = 16f
                    text = "${m.name}\n${m.description}\n\n" +
                        "Operation: ${m.operationReference} -> ${s.entrypoint.humanLabel}\n" +
                        "Approval tier referenced: ${m.approvalTierReference} (decided by the backend, not by this file)\n" +
                        "Provenance: ${m.provenance}\n" +
                        "Last verified: app ${m.lastVerifiedAppVersion} on ${m.lastVerifiedDate}" +
                        (m.lastVerifiedApkSha256?.let { "\n  apk sha256 $it" } ?: "") +
                        (m.lastVerifiedSignerSha256?.let { "\n  signer sha256 $it" } ?: "") +
                        "\nSchema v${m.schemaVersion}\n\n$verdictText"
                })
                detail.addView(Button(this).apply {
                    text = s.entrypoint.humanLabel
                    isEnabled = s.dispatchAllowed
                    setOnClickListener { dispatch(s) }
                })
                detail.addView(TextView(this).apply { text = "\n--- Procedure text (displayed, not executed) ---\n\n${m.body}" })
            }
        }
    }

    /** Explicit, in-package Intent to the mapped Activity. No extras: the target screen keeps all its own gates. */
    private fun dispatch(s: LoadedSkill.Supported) {
        if (!s.dispatchAllowed) return
        val intent = Intent().apply {
            component = ComponentName(packageName, s.entrypoint.activityClassName)
            setPackage(packageName)
        }
        startActivity(intent)
    }
}
