package com.aihangout.companion.diagnostics

import com.aihangout.companion.data.AssistanceProposalValidator
import com.aihangout.companion.data.DiagnosticsPreference
import org.json.JSONObject

/**
 * Executor for the one approved repair this app supports: flip THIS app's
 * own diagnostics preference on, then prove it by a fresh battery read. It
 * never touches system settings, other apps, or coordinates -- there is no
 * generic "click" here at all; the target string is matched literally and
 * anything else is refused before any side effect.
 */
class RepairExecutor(private val preference: DiagnosticsPreference, private val reader: DeviceReader) {

    data class Outcome(val preferenceBefore: Boolean, val preferenceAfter: Boolean, val battery: BatteryStatus) {
        fun toContentJson(): String = JSONObject()
            .put("operation", AssistanceProposalValidator.OPERATION)
            .put("preferenceBefore", preferenceBefore)
            .put("preferenceAfter", preferenceAfter)
            .put("battery", JSONObject().put("percent", battery.percent).put("isCharging", battery.isCharging))
            .toString()
    }

    fun execute(capability: String, targetDescription: String): Outcome {
        if (capability != AssistanceProposalValidator.CAPABILITY || targetDescription != AssistanceProposalValidator.TARGET) {
            throw IllegalArgumentException("Refusing to execute: only '${AssistanceProposalValidator.TARGET}' via ${AssistanceProposalValidator.CAPABILITY} is supported (got $capability / '$targetDescription').")
        }
        val before = preference.isEnabled()
        preference.setEnabled(true)              // commit-checked; throws before any read if it did not persist
        val after = preference.isEnabled()
        if (!after) throw IllegalStateException("Preference did not read back as enabled after the write.")
        preference.requireEnabled()
        val battery = reader.readBatteryStatus()
        return Outcome(before, after, battery)
    }
}
