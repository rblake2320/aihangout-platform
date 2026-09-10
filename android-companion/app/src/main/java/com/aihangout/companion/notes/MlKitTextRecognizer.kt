package com.aihangout.companion.notes

import android.content.Context
import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.File

/**
 * ML Kit Text Recognition v2 with the BUNDLED Latin model: the model ships
 * inside the APK, inference is fully on-device, no Play Services model
 * download and no network. Nothing else from ML Kit (no face detection) is
 * linked. Callbacks arrive on the main thread (ML Kit Task listeners).
 */
class MlKitTextRecognizer(private val context: Context) : TextRecognizer {
    override val engine: String = "mlkit-text-recognition-latin-bundled"

    override fun recognize(image: File, onResult: (Result<String>) -> Unit) {
        val input = try {
            InputImage.fromFilePath(context, Uri.fromFile(image))
        } catch (e: Exception) {
            onResult(Result.failure(e)); return
        }
        val client = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        client.process(input)
            .addOnSuccessListener { visionText -> onResult(Result.success(visionText.text)) }
            .addOnFailureListener { e -> onResult(Result.failure(e)) }
            .addOnCompleteListener { client.close() }
    }
}
