package com.aihangout.companion.skills

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.io.File
import java.security.MessageDigest

/**
 * Reads the procedures bundled INTO this APK under `assets/skills/<name>/SKILL.md`
 * (copied at build time from the repo's reviewed `phone-skills/` directory --
 * see app/build.gradle.kts `bundleSkills`). Assets are read-only, ship with the
 * signed APK, and cannot be added to or replaced at runtime: there is no
 * download, no external directory scan, no dynamic code. Only the two
 * directories the registry expects are even considered.
 */
class BundledSkillLoader(private val context: Context) {

    fun load(): List<LoadedSkill> {
        val installed = installedIdentity()
        val present = try { context.assets.list("skills")?.toList() ?: emptyList() } catch (e: Exception) { emptyList() }
        val names = (SkillRegistry.BUNDLED_SKILL_NAMES + present).toSortedSet()
        return names.map { dir ->
            val text = if (dir in present) readAsset("skills/$dir/SKILL.md") else null
            SkillResolver.resolve(dir, text, installed)
        }
    }

    private fun readAsset(path: String): String? = try {
        context.assets.open(path).use { input ->
            val bytes = input.readBytes()
            if (bytes.size > SkillManifest.MAX_FILE_CHARS * 4) null else String(bytes, Charsets.UTF_8)
        }
    } catch (e: Exception) { null }

    /** Version + APK file hash + signing-cert hash of THIS installed build; null fields fail closed in the gate. */
    fun installedIdentity(): InstalledIdentity {
        val pm = context.packageManager
        val version = try { pm.getPackageInfo(context.packageName, 0).versionName ?: "" } catch (e: Exception) { "" }
        val apkSha = try { sha256(File(context.applicationInfo.sourceDir)) } catch (e: Exception) { null }
        val signer = try {
            val sigs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val info = pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo
                if (info == null) null else if (info.hasMultipleSigners()) info.apkContentsSigners else info.signingCertificateHistory
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES).signatures
            }
            val first = sigs?.firstOrNull() ?: return InstalledIdentity(version, apkSha, null)
            MessageDigest.getInstance("SHA-256").digest(first.toByteArray()).joinToString("") { "%02x".format(it) }
        } catch (e: Exception) { null }
        return InstalledIdentity(version, apkSha, signer)
    }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
