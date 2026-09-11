package com.aihangout.companion.scheduler

import org.json.JSONObject

/**
 * Phone-local scheduled operations (Team/tasks/A3-scheduler-assignment-20260911.md).
 * The operation vocabulary is CLOSED: ids are stable strings so the set can
 * grow, but only ids listed in [OperationRegistry.SUPPORTED] ever execute.
 * SMS-class ids are reserved and REFUSED until the governed SMS adapter is
 * reviewed and integrated -- there is no direct SMS grant in this package.
 */
object OperationRegistry {
    const val BATTERY_STATUS_READ = "battery_status_read"

    /** The only operations this package will execute today. */
    val SUPPORTED: Set<String> = setOf(BATTERY_STATUS_READ)

    /** Known-but-refused ids: reserved so a future adapter can claim them; never executed here. */
    val RESERVED_REFUSED: Set<String> = setOf("sms_send", "call_make", "email_send")

    sealed class Decision {
        data class Supported(val id: String) : Decision()
        data class Refused(val id: String, val reason: String) : Decision()
    }

    fun decide(raw: String?): Decision {
        val id = raw?.trim().orEmpty()
        return when {
            id in SUPPORTED -> Decision.Supported(id)
            id in RESERVED_REFUSED -> Decision.Refused(id, "reserved for the governed SMS/communication adapter; not integrated -- refused")
            else -> Decision.Refused(id, "unknown operation id -- refused")
        }
    }
}

enum class JobStatus { PENDING, CANCELLED, RUNNING, COMPLETED, UNKNOWN, MISSED }

data class ScheduledJob(
    val id: String,
    val operation: String,
    val fireAtEpochMs: Long,
    val timeZoneId: String,
    val status: JobStatus,
    val createdAtEpochMs: Long,
    val claimedAtEpochMs: Long? = null,
    val finishedAtEpochMs: Long? = null,
    val resultJson: String? = null,   // private; never uploaded by this package
    val note: String? = null
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("operation", operation).put("fireAtEpochMs", fireAtEpochMs).put("timeZoneId", timeZoneId)
        .put("status", status.name).put("createdAtEpochMs", createdAtEpochMs)
        .putOpt("claimedAtEpochMs", claimedAtEpochMs).putOpt("finishedAtEpochMs", finishedAtEpochMs)
        .putOpt("resultJson", resultJson).putOpt("note", note)
}
