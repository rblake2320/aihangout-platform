package com.aihangout.companion.data

import org.json.JSONObject

/**
 * One-time, GET-only migration of the pre-snapshot `lastResult` string
 * ("Action <uuid>: Final state: ...") that both Motos carry. It never creates
 * an action or calls a model: the action id is extracted STRICTLY from the
 * legacy line, the identity comes from the existing DeviceBinding (owner +
 * backend + device), and the readback is authenticated against both before a
 * snapshot is saved. Anything short of an exact match migrates nothing.
 */
object LegacyResultMigration {
    private val LEGACY = Regex("""^Action ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}): """)

    /** Strict extraction: the line must start with "Action <uuid-v4-shaped>: ". */
    fun extractActionId(legacyLastResult: String?): String? =
        legacyLastResult?.let { LEGACY.find(it)?.groupValues?.get(1) }

    sealed class Plan {
        /** Nothing to migrate (no legacy line, unparseable, or no usable binding). */
        data class None(val reason: String) : Plan()
        /** GET this action, then require [bind] to pass before saving. */
        data class Fetch(val actionId: String, val ownerUserId: String, val baseUrl: String, val deviceId: String) : Plan()
    }

    fun plan(legacyLastResult: String?, hasSnapshot: Boolean, binding: JSONObject?, currentBaseUrl: String): Plan {
        if (hasSnapshot) return Plan.None("snapshot already present")
        val actionId = extractActionId(legacyLastResult) ?: return Plan.None("no strict action id in legacy result")
        if (binding == null) return Plan.None("no device binding; identity unknown, refusing to guess")
        val baseUrl = binding.optString("baseUrl")
        if (baseUrl != currentBaseUrl) return Plan.None("binding is for $baseUrl, not this backend")
        val owner = binding.optString("ownerUserId"); val device = binding.optString("deviceId")
        if (owner.isEmpty() || device.isEmpty()) return Plan.None("binding incomplete")
        return Plan.Fetch(actionId, owner, baseUrl, device)
    }

    /** Authenticate the readback identity: exact action id AND the bound device id. */
    fun bind(readback: JSONObject, fetch: Plan.Fetch): Boolean {
        val intent = readback.optJSONObject("intent") ?: return false
        return intent.optString("action_id") == fetch.actionId && intent.optString("device_id") == fetch.deviceId
    }
}
