package com.aihangout.companion.skills

/**
 * A reviewed procedure file (`phone-skills/<name>/SKILL.md`) as the app sees it:
 * a small, flat YAML-like frontmatter block between `---` lines, then Markdown
 * body text that is DISPLAYED, never interpreted. Parsing is deliberately
 * minimal (no YAML library, no nesting, no anchors) so a file cannot smuggle
 * structure the validator does not know about.
 *
 * Authority note: nothing in a manifest grants anything. `operationReference`
 * is only a KEY into [SkillRegistry]'s closed allowlist; an unknown key is a
 * refused skill, not a new capability.
 */
data class SkillManifest(
    val name: String,
    val description: String,
    val operationReference: String,
    val approvalTierReference: String,
    val lastVerifiedAppVersion: String,
    val lastVerifiedApkSha256: String?,
    val lastVerifiedSignerSha256: String?,
    val lastVerifiedDate: String,
    val provenance: String,
    val schemaVersion: Int,
    /** Markdown body after the frontmatter; shown as plain text. */
    val body: String
) {
    companion object {
        const val SUPPORTED_SCHEMA_VERSION = 1
        const val MAX_FILE_CHARS = 64_000
        val NAME_RE = Regex("^[a-z0-9]+(-[a-z0-9]+)*$")
        val OPERATION_RE = Regex("^[a-z0-9_]{3,64}$")
        val SHA256_RE = Regex("^[0-9a-f]{64}$")
        val VERSION_RE = Regex("^[0-9]+\\.[0-9]+\\.[0-9]+$")
        val DATE_RE = Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
        val KEY_RE = Regex("^[a-z][a-z0-9_]{0,39}$")
        private val REQUIRED = listOf(
            "name", "description", "operation_reference", "approval_tier_reference",
            "last_verified_app_version", "last_verified_date", "provenance"
        )
        private val KNOWN = REQUIRED + listOf("last_verified_apk_sha256", "last_verified_signer_sha256", "schema_version")

        sealed class Parsed {
            data class Ok(val manifest: SkillManifest) : Parsed()
            data class Refused(val reason: String) : Parsed()
        }

        /**
         * Parse + validate one file. [expectedName] is the directory the file was
         * found in; the frontmatter `name` must match it so a file cannot claim to
         * be a different skill. Never throws.
         */
        fun parse(text: String, expectedName: String): Parsed {
            try {
                if (text.length > MAX_FILE_CHARS) return Parsed.Refused("file too large")
                val unified = text.replace("\r\n", "\n").replace('\r', '\n').removePrefix("\uFEFF")
                val lines = unified.split('\n')
                if (lines.isEmpty() || lines[0].trim() != "---") return Parsed.Refused("missing frontmatter start")
                val end = lines.drop(1).indexOfFirst { it.trim() == "---" }
                if (end < 0) return Parsed.Refused("missing frontmatter end")
                val fm = LinkedHashMap<String, String>()
                for (raw in lines.subList(1, end + 1)) {
                    val line = raw.trimEnd()
                    if (line.isBlank() || line.trimStart().startsWith("#")) continue
                    if (line.startsWith(" ") || line.startsWith("\t")) return Parsed.Refused("nested frontmatter is not allowed")
                    val idx = line.indexOf(':')
                    if (idx <= 0) return Parsed.Refused("malformed frontmatter line")
                    val key = line.substring(0, idx).trim()
                    if (!KEY_RE.matches(key)) return Parsed.Refused("bad frontmatter key")
                    if (fm.containsKey(key)) return Parsed.Refused("duplicate frontmatter key '$key'")
                    if (key !in KNOWN) return Parsed.Refused("unknown frontmatter key '$key'")
                    fm[key] = unquote(line.substring(idx + 1).trim())
                }
                for (k in REQUIRED) if (fm[k].isNullOrBlank()) return Parsed.Refused("missing '$k'")
                val schema = fm["schema_version"]?.toIntOrNull() ?: SUPPORTED_SCHEMA_VERSION
                if (schema != SUPPORTED_SCHEMA_VERSION) return Parsed.Refused("unsupported schema_version $schema")
                val name = fm.getValue("name")
                if (!NAME_RE.matches(name)) return Parsed.Refused("bad name")
                if (name != expectedName) return Parsed.Refused("name '$name' does not match its directory '$expectedName'")
                val op = fm.getValue("operation_reference")
                if (!OPERATION_RE.matches(op)) return Parsed.Refused("bad operation_reference")
                val version = fm.getValue("last_verified_app_version")
                if (!VERSION_RE.matches(version)) return Parsed.Refused("bad last_verified_app_version")
                if (!DATE_RE.matches(fm.getValue("last_verified_date"))) return Parsed.Refused("bad last_verified_date")
                val apk = fm["last_verified_apk_sha256"]; val signer = fm["last_verified_signer_sha256"]
                if (apk == null && signer == null) return Parsed.Refused("no artifact identity (apk or signer sha256)")
                if (apk != null && !SHA256_RE.matches(apk)) return Parsed.Refused("bad last_verified_apk_sha256")
                if (signer != null && !SHA256_RE.matches(signer)) return Parsed.Refused("bad last_verified_signer_sha256")
                val body = lines.drop(end + 2).joinToString("\n").trim()
                if (body.isBlank()) return Parsed.Refused("empty procedure body")
                return Parsed.Ok(SkillManifest(
                    name = name, description = fm.getValue("description"), operationReference = op,
                    approvalTierReference = fm.getValue("approval_tier_reference"), lastVerifiedAppVersion = version,
                    lastVerifiedApkSha256 = apk, lastVerifiedSignerSha256 = signer,
                    lastVerifiedDate = fm.getValue("last_verified_date"), provenance = fm.getValue("provenance"),
                    schemaVersion = schema, body = body
                ))
            } catch (e: Exception) {
                return Parsed.Refused("unreadable: ${e.javaClass.simpleName}")
            }
        }

        private fun unquote(v: String): String =
            if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\'')))) v.substring(1, v.length - 1) else v
    }
}
