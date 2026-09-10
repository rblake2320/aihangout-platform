package com.aihangout.companion.data

class DiagnosticsDisabledException(message: String) : Exception(message)

/**
 * The one real, persisted app preference this first frontier workflow is
 * allowed to repair (Team/tasks/A1-frontier-phone-wiring-contract-20260910.md).
 * Default DISABLED: the battery read is genuinely refused until either the
 * human toggles it here or an approved `enable_companion_diagnostics`
 * action flips it. Commit-checked so a write that did not reach disk is an
 * error, never a silently unchanged state.
 */
class DiagnosticsPreference(private val store: PhaseStore) {
    fun isEnabled(): Boolean = store.get(KEY) == "true"

    fun setEnabled(enabled: Boolean) {
        if (!store.put(KEY, enabled.toString())) throw PhaseWriteException("Failed to persist companion diagnostics preference.")
    }

    /** Gate in front of every diagnostic read. */
    fun requireEnabled() {
        if (!isEnabled()) throw DiagnosticsDisabledException(
            "Companion diagnostics are DISABLED; the battery check will not run. Enable the preference or use 'Ask AI for help'."
        )
    }

    companion object { const val KEY = "companion_diagnostics_enabled" }
}
