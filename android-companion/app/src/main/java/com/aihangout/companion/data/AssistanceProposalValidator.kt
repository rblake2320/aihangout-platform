package com.aihangout.companion.data

import org.json.JSONObject

/**
 * The ONLY proposal this client will act on is the exact fixed triple from
 * the shared contract. Anything else -- a different operation, capability,
 * target wording, extra fields that change meaning, a model-supplied device,
 * command, url or coordinate -- is not "close enough"; it is refused, and the
 * diagnosis is shown as untrusted plain text regardless.
 */
object AssistanceProposalValidator {
    const val OPERATION = "enable_companion_diagnostics"
    const val CAPABILITY = "ui_click"
    const val TARGET = "Enable AIHangout companion diagnostics"
    private const val MAX_DIAGNOSIS_CHARS = 1500

    sealed class Outcome {
        data class Accepted(val diagnosis: String) : Outcome()
        data class NoAction(val diagnosis: String) : Outcome()
        data class Rejected(val diagnosis: String, val reason: String) : Outcome()
    }

    /** [expectedRequestId] must match the echoed requestId or the whole response is rejected. */
    fun validate(response: JSONObject, expectedRequestId: String): Outcome {
        val diagnosis = plainText(response.optString("diagnosis", ""))
        if (response.optString("requestId") != expectedRequestId) {
            return Outcome.Rejected(diagnosis, "response requestId does not match the request this device sent")
        }
        val proposal = response.optJSONObject("proposal")
        if (proposal == null) {
            return Outcome.NoAction(diagnosis)
        }
        val op = proposal.optString("operation")
        if (op == "no_action") return Outcome.NoAction(diagnosis)
        val problems = mutableListOf<String>()
        if (op != OPERATION) problems += "operation"
        if (proposal.optString("capability") != CAPABILITY) problems += "capability"
        if (proposal.optString("targetDescription") != TARGET) problems += "targetDescription"
        val allowedKeys = setOf("operation", "capability", "targetDescription")
        val extra = proposal.keys().asSequence().filter { it !in allowedKeys }.toList()
        if (extra.isNotEmpty()) problems += "unexpected fields: ${extra.joinToString()}"
        return if (problems.isEmpty()) Outcome.Accepted(diagnosis)
        else Outcome.Rejected(diagnosis, "proposal is not the fixed contract: ${problems.joinToString(", ")}")
    }

    /** Strip control characters and bound length: rendered as text, never interpreted. */
    fun plainText(s: String): String {
        val cleaned = s.filter { it == '\n' || it == '\t' || it.code >= 0x20 }
        return if (cleaned.length > MAX_DIAGNOSIS_CHARS) cleaned.take(MAX_DIAGNOSIS_CHARS) + "… [truncated]" else cleaned
    }
}
