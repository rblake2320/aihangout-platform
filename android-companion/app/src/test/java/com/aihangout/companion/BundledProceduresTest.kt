package com.aihangout.companion

import com.aihangout.companion.skills.InstalledIdentity
import com.aihangout.companion.skills.LoadedSkill
import com.aihangout.companion.skills.LocalEntrypoint
import com.aihangout.companion.skills.SkillRegistry
import com.aihangout.companion.skills.SkillResolver
import com.aihangout.companion.skills.SkillVerdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The REAL reviewed files the build bundles (`phone-skills/<name>/SKILL.md`,
 * read from the repo, exactly what app/build.gradle.kts `bundleSkills` copies
 * into assets). If a reviewed file drifts out of schema or references an
 * operation this build does not allowlist, this fails before any APK exists.
 */
class BundledProceduresTest {

    private val skillsRoot: File = generateSequence(File("").absoluteFile) { it.parentFile }
        .map { File(it, "phone-skills") }.firstOrNull { it.isDirectory }
        ?: error("phone-skills directory not found above ${File("").absoluteFile}")

    private fun read(name: String): String? = File(skillsRoot, "$name/SKILL.md").takeIf { it.isFile }?.readText(Charsets.UTF_8)

    // Whatever this build reports; the gate is evaluated against it, and the test
    // states the expected verdict for each file rather than assuming "verified".
    private val debugSigner = "b709192f6a09f7c1a93addb13d766f4ad5f134747862d4b7f4814357d9fc0b4e"
    private val installed = InstalledIdentity("0.1.0", "ff".repeat(32), debugSigner)

    @Test
    fun `both expected bundled directories exist in the repo and parse as supported skills`() {
        for (name in SkillRegistry.BUNDLED_SKILL_NAMES) {
            val r = SkillResolver.resolve(name, read(name), installed)
            assertTrue("$name: $r", r is LoadedSkill.Supported)
        }
    }

    @Test
    fun `companion-diagnostics maps to the existing companion flow and pins an APK hash, so a new build is UNVERIFIED until A1 revalidates`() {
        val r = SkillResolver.resolve("companion-diagnostics", read("companion-diagnostics"), installed) as LoadedSkill.Supported
        assertEquals("enable_companion_diagnostics", r.manifest.operationReference)
        assertEquals(LocalEntrypoint.COMPANION_ASSISTANCE, r.entrypoint)
        assertEquals("device_ui_action", r.manifest.approvalTierReference)
        assertTrue(r.manifest.lastVerifiedApkSha256 != null)
        // Installed APK hash differs from the one recorded in the file -> the loader must refuse dispatch.
        assertFalse(r.dispatchAllowed)
        assertTrue((r.verdict as SkillVerdict.Unverified).reasons.any { it.contains("APK sha256") })
        // ...and would allow it for the exact recorded artifact.
        val exact = SkillResolver.resolve("companion-diagnostics", read("companion-diagnostics"), installed.copy(apkSha256 = r.manifest.lastVerifiedApkSha256)) as LoadedSkill.Supported
        assertTrue(exact.dispatchAllowed)
    }

    @Test
    fun `camera-notes maps to CameraNotesActivity and is verified for the debug signer at version 0_1_0`() {
        val r = SkillResolver.resolve("camera-notes", read("camera-notes"), installed) as LoadedSkill.Supported
        assertEquals("capture_camera_note", r.manifest.operationReference)
        assertEquals(LocalEntrypoint.CAMERA_NOTES, r.entrypoint)
        assertEquals("local_only", r.manifest.approvalTierReference)
        assertTrue(r.dispatchAllowed)
        assertFalse((SkillResolver.resolve("camera-notes", read("camera-notes"), installed.copy(signerSha256 = "00".repeat(32))) as LoadedSkill.Supported).dispatchAllowed)
    }

    @Test
    fun `no bundled file references an operation outside the allowlist and bodies are non-trivial`() {
        for (name in SkillRegistry.BUNDLED_SKILL_NAMES) {
            val r = SkillResolver.resolve(name, read(name), installed) as LoadedSkill.Supported
            assertTrue(SkillRegistry.ALLOWLIST.containsKey(r.manifest.operationReference))
            assertTrue(r.manifest.body.contains("## Preconditions"))
            assertTrue(r.manifest.body.contains("## Procedure"))
        }
    }
}
