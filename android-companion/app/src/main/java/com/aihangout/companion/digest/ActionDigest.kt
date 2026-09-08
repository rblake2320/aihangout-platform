package com.aihangout.companion.digest

import java.security.MessageDigest

/**
 * Reproduces the backend's server-computed action_digest so the app can
 * verify (not just relay) what a human is being asked to approve, as
 * defense-in-depth against a compromised network path tampering with
 * riskTier specifically (e.g. downgrading a communication_send action to
 * read_only to skip the confirm-phrase gate). TLS is the first line of
 * defense; this is the second, independent of it.
 *
 * Backend formula (src/worker.js, POST /api/mobile/actions/intent):
 *   sha256Hex(JSON.stringify({ deviceId, capability, riskTier, targetDescription }))
 * with JS JSON.stringify's exact key order and escaping. Byte-for-byte
 * parity with real Node output was verified for this fixed 4-string-field
 * shape (including quote/backslash/newline/tab/non-ASCII cases) before
 * this function was written -- see the design-review receipts referenced
 * from Team/tasks/A3-to-A1-current-help-20260908.md. Not a general JSON
 * library reimplementation: only this exact, fixed object shape is
 * supported.
 *
 * Known deliberate scope limit: unpaired UTF-16 surrogates are not
 * special-cased (ES2019 JSON.stringify escapes lone surrogates as
 * \uXXXX; this does not). Not a concern for deviceId/capability/riskTier
 * (controlled enums/IDs). If targetDescription is ever populated from
 * unsanitized free text that could contain emoji/lone surrogates, that
 * gap needs closing before relying on this for anything beyond the
 * defense-in-depth check described above.
 */
object ActionDigest {

    private const val BACKSLASH = '\\'
    private const val QUOTE = '"'
    private const val BACKSPACE = '\b'
    private const val FORM_FEED = '\u000C'
    private const val NEWLINE = '\n'
    private const val CARRIAGE_RETURN = '\r'
    private const val TAB = '\t'

    fun compute(deviceId: String, capability: String, riskTier: String, targetDescription: String): String {
        val json = buildString {
            append("{\"deviceId\":\"").append(jsonEscape(deviceId)).append('"')
            append(",\"capability\":\"").append(jsonEscape(capability)).append('"')
            append(",\"riskTier\":\"").append(jsonEscape(riskTier)).append('"')
            append(",\"targetDescription\":\"").append(jsonEscape(targetDescription)).append("\"}")
        }
        val bytes = MessageDigest.getInstance("SHA-256").digest(json.toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun jsonEscape(s: String): String {
        val sb = StringBuilder(s.length + 8)
        for (ch in s) {
            when (ch) {
                QUOTE -> sb.append("\\\"")
                BACKSLASH -> sb.append("\\\\")
                BACKSPACE -> sb.append("\\b")
                FORM_FEED -> sb.append("\\f")
                NEWLINE -> sb.append("\\n")
                CARRIAGE_RETURN -> sb.append("\\r")
                TAB -> sb.append("\\t")
                else -> if (ch.code < 0x20) {
                    sb.append("\\u%04x".format(ch.code))
                } else {
                    sb.append(ch) // non-ASCII passes through raw, matching JSON.stringify
                }
            }
        }
        return sb.toString()
    }
}
