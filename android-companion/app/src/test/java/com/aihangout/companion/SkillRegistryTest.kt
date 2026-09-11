package com.aihangout.companion

import com.aihangout.companion.skills.InstalledIdentity
import com.aihangout.companion.skills.LoadedSkill
import com.aihangout.companion.skills.LocalEntrypoint
import com.aihangout.companion.skills.SkillManifest
import com.aihangout.companion.skills.SkillRegistry
import com.aihangout.companion.skills.SkillResolver
import com.aihangout.companion.skills.SkillVerdict
import com.aihangout.companion.skills.SkillVerification
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SkillRegistryTest {

    private val signer = "b7".repeat(32)
    private val apk = "c3".repeat(32)
    private fun text(name: String, op: String, tier: String = "local_only", apkSha: String? = null, signerSha: String? = signer, version: String = "0.1.0") = buildString {
        append("---\nname: $name\ndescription: d\noperation_reference: $op\napproval_tier_reference: $tier\n")
        append("last_verified_app_version: \"$version\"\n")
        if (apkSha != null) append("last_verified_apk_sha256: $apkSha\n")
        if (signerSha != null) append("last_verified_signer_sha256: $signerSha\n")
        append("last_verified_date: \"2026-09-10\"\nprovenance: p\n---\n# body\nsteps\n")
    }
    private val installed = InstalledIdentity("0.1.0", apk, signer)

    @Test
    fun `the allowlist is closed - exactly two operations, each mapped to an in-package Activity`() {
        assertEquals(setOf("enable_companion_diagnostics", "capture_camera_note"), SkillRegistry.ALLOWLIST.keys)
        assertEquals(LocalEntrypoint.COMPANION_ASSISTANCE, SkillRegistry.entrypointFor("enable_companion_diagnostics"))
        assertEquals(LocalEntrypoint.CAMERA_NOTES, SkillRegistry.entrypointFor("capture_camera_note"))
        assertNull(SkillRegistry.entrypointFor("send_sms"))
        for (e in LocalEntrypoint.values()) assertTrue(e.activityClassName.startsWith("com.aihangout.companion.ui."))
    }

    @Test
    fun `an unknown operation in a valid file is refused - Markdown cannot add capabilities`() {
        val r = SkillResolver.resolve("camera-notes", text("camera-notes", "factory_reset"), installed)
        assertTrue(r is LoadedSkill.Refused)
        assertTrue((r as LoadedSkill.Refused).reason.contains("not supported by this build"))
    }

    @Test
    fun `a directory outside the expected bundle is refused even if its file is perfect`() {
        val r = SkillResolver.resolve("extra-skill", text("extra-skill", "capture_camera_note"), installed)
        assertTrue((r as LoadedSkill.Refused).reason.contains("not an expected bundled skill"))
        assertTrue(SkillResolver.resolve("camera-notes", null, installed) is LoadedSkill.Refused)
    }

    @Test
    fun `an unknown approval tier is refused`() {
        val r = SkillResolver.resolve("camera-notes", text("camera-notes", "capture_camera_note", tier = "root"), installed)
        assertTrue((r as LoadedSkill.Refused).reason.contains("unknown approval tier"))
    }

    @Test
    fun `verification gate - every declared identity must match, unknown installed identity fails closed`() {
        val m = (SkillManifest.parse(text("camera-notes", "capture_camera_note", apkSha = apk), "camera-notes") as SkillManifest.Companion.Parsed.Ok).manifest
        assertTrue(SkillVerification.evaluate(m, installed) is SkillVerdict.Verified)
        val wrongVersion = SkillVerification.evaluate(m, installed.copy(appVersion = "0.2.0")) as SkillVerdict.Unverified
        assertTrue(wrongVersion.reasons.single().contains("app version"))
        val wrongApk = SkillVerification.evaluate(m, installed.copy(apkSha256 = "00".repeat(32))) as SkillVerdict.Unverified
        assertTrue(wrongApk.reasons.single().contains("APK sha256"))
        val noSigner = SkillVerification.evaluate(m, installed.copy(signerSha256 = null)) as SkillVerdict.Unverified
        assertTrue(noSigner.reasons.single().contains("signer unavailable"))
        val allWrong = SkillVerification.evaluate(m, InstalledIdentity("9.9.9", null, null)) as SkillVerdict.Unverified
        assertEquals(3, allWrong.reasons.size)
    }

    @Test
    fun `dispatch is allowed only for a supported AND verified skill`() {
        val ok = SkillResolver.resolve("camera-notes", text("camera-notes", "capture_camera_note"), installed) as LoadedSkill.Supported
        assertTrue(ok.dispatchAllowed)
        assertEquals(LocalEntrypoint.CAMERA_NOTES, ok.entrypoint)
        val stale = SkillResolver.resolve("camera-notes", text("camera-notes", "capture_camera_note", version = "0.0.9"), installed) as LoadedSkill.Supported
        assertFalse(stale.dispatchAllowed)
        assertTrue(stale.verdict is SkillVerdict.Unverified)
    }
}
