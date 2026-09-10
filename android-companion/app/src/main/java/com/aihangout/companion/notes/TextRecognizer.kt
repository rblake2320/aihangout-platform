package com.aihangout.companion.notes

import java.io.File

/**
 * On-device OCR port. Implementations must not touch the network. The
 * activity depends on this interface; the ML Kit implementation is the only
 * production one and the unit tests substitute a fake (unavoidable on a plain
 * JVM -- the real recogniser is exercised by A1's device test with printed text).
 */
interface TextRecognizer {
    /** Stable engine identifier stored with the note for provenance. */
    val engine: String

    /** Recognise text in [image]; [onResult] is invoked exactly once, on the caller's main thread. */
    fun recognize(image: File, onResult: (Result<String>) -> Unit)
}
