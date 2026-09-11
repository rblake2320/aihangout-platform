package com.aihangout.companion.skills

/**
 * The CLOSED allowlist: which `operation_reference` values this build knows,
 * and which local, already-existing screen each one opens. This is Kotlin,
 * compiled in, reviewed with the code. A SKILL.md can reference one of these
 * keys or be refused; it cannot add to this table, and no entry here performs
 * an action by itself -- each opens an Activity where the existing gates
 * (web approval, digest verification, explicit Save) still apply.
 */
enum class LocalEntrypoint(val activityClassName: String, val humanLabel: String) {
    /** Existing companion flow in MainActivity ("Ask AI for help" -> web approval -> execute). */
    COMPANION_ASSISTANCE("com.aihangout.companion.ui.MainActivity", "Open companion (use 'Ask AI for help')"),
    /** Camera -> on-device OCR -> explicit save (CameraNotesActivity). */
    CAMERA_NOTES("com.aihangout.companion.ui.CameraNotesActivity", "Open camera notes")
}

object SkillRegistry {
    /** operation_reference -> entrypoint. Adding a row is a code change with review, never a file drop. */
    val ALLOWLIST: Map<String, LocalEntrypoint> = mapOf(
        "enable_companion_diagnostics" to LocalEntrypoint.COMPANION_ASSISTANCE,
        "capture_camera_note" to LocalEntrypoint.CAMERA_NOTES
    )

    /** Bundled skill directory names this build expects; anything else in the bundle is refused. */
    val BUNDLED_SKILL_NAMES: Set<String> = setOf("companion-diagnostics", "camera-notes")

    /** Approval tiers a skill may reference (display + sanity only; the backend decides tiers). */
    val KNOWN_APPROVAL_TIERS: Set<String> = setOf("device_ui_action", "local_only")

    fun entrypointFor(operationReference: String): LocalEntrypoint? = ALLOWLIST[operationReference]
}

/** What the running app knows about itself, for the verification gate. Pure data so tests can supply it. */
data class InstalledIdentity(val appVersion: String, val apkSha256: String?, val signerSha256: String?)

/**
 * Runtime version/artifact gate the SKILL.md text asks for but cannot enforce
 * itself ("a mismatch requires revalidation before using this procedure").
 * Every declared identity field must match; a field the app cannot compute
 * counts as a mismatch (fail closed), never as a pass.
 */
sealed class SkillVerdict {
    object Verified : SkillVerdict()
    data class Unverified(val reasons: List<String>) : SkillVerdict()
}

object SkillVerification {
    fun evaluate(m: SkillManifest, installed: InstalledIdentity): SkillVerdict {
        val reasons = ArrayList<String>()
        if (m.lastVerifiedAppVersion != installed.appVersion) reasons += "app version ${installed.appVersion} != verified ${m.lastVerifiedAppVersion}"
        m.lastVerifiedApkSha256?.let { want ->
            val have = installed.apkSha256
            if (have == null) reasons += "installed APK hash unavailable" else if (have != want) reasons += "APK sha256 ${have.take(12)}… != verified ${want.take(12)}…"
        }
        m.lastVerifiedSignerSha256?.let { want ->
            val have = installed.signerSha256
            if (have == null) reasons += "installed signer unavailable" else if (have != want) reasons += "signer sha256 ${have.take(12)}… != verified ${want.take(12)}…"
        }
        return if (reasons.isEmpty()) SkillVerdict.Verified else SkillVerdict.Unverified(reasons)
    }
}

/** One bundled skill after loading: either usable, visible-but-blocked, or refused outright. */
sealed class LoadedSkill {
    abstract val directory: String

    /** Parsed, allowlisted; [verdict] decides whether dispatch is enabled. */
    data class Supported(override val directory: String, val manifest: SkillManifest, val entrypoint: LocalEntrypoint, val verdict: SkillVerdict) : LoadedSkill() {
        val dispatchAllowed: Boolean get() = verdict is SkillVerdict.Verified
    }

    /** Parsed but its operation is not in the allowlist, or the directory is not an expected bundled skill. */
    data class Refused(override val directory: String, val reason: String, val manifest: SkillManifest? = null) : LoadedSkill()
}

/** Pure resolution of a file's text into a [LoadedSkill]; the Android loader only supplies the text. */
object SkillResolver {
    fun resolve(directory: String, text: String?, installed: InstalledIdentity): LoadedSkill {
        if (directory !in SkillRegistry.BUNDLED_SKILL_NAMES) return LoadedSkill.Refused(directory, "not an expected bundled skill")
        if (text == null) return LoadedSkill.Refused(directory, "SKILL.md missing or unreadable")
        return when (val p = SkillManifest.parse(text, directory)) {
            is SkillManifest.Companion.Parsed.Refused -> LoadedSkill.Refused(directory, p.reason)
            is SkillManifest.Companion.Parsed.Ok -> {
                val m = p.manifest
                val ep = SkillRegistry.entrypointFor(m.operationReference)
                    ?: return LoadedSkill.Refused(directory, "operation '${m.operationReference}' is not supported by this build", m)
                if (m.approvalTierReference !in SkillRegistry.KNOWN_APPROVAL_TIERS) return LoadedSkill.Refused(directory, "unknown approval tier '${m.approvalTierReference}'", m)
                LoadedSkill.Supported(directory, m, ep, SkillVerification.evaluate(m, installed))
            }
        }
    }
}
