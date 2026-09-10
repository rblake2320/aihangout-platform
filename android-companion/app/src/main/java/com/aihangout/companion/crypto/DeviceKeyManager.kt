package com.aihangout.companion.crypto

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.KeyStoreException
import java.security.MessageDigest
import java.security.ProviderException
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Real, hardware-backed (where available) device key management, per
 * Team/tasks/A1-to-A3-enrollment-contract-20260908.md: EC P-256, key
 * material generated in the Android Keystore (never exportable), signing
 * done via the Keystore-held private key so the raw key never exists in
 * app memory.
 *
 * keySecurityLevel is reported honestly (best-effort local check) but the
 * backend contract is explicit that it is stored as a client declaration
 * only, NOT verified attestation -- this class does not claim otherwise.
 */
class DeviceKeyManager(private val context: Context) {

    companion object {
        private const val KEYSTORE_ALIAS = "aihangout_device_key"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val LOG_TAG = "AIHangoutDeviceKey"
    }

    /**
     * Thrown when NEITHER the StrongBox nor the non-StrongBox fallback
     * attempt could generate a key, with both underlying exceptions
     * (type, message, and cause chain) captured in the message so this
     * is self-diagnosing from the app's own log/UI without needing raw
     * logcat pulled off the device separately.
     */
    class KeyGenerationFailedException(message: String) : Exception(message)

    private fun describeException(e: Throwable): String {
        val chain = generateSequence(e as Throwable?) { it.cause }.toList()
        return chain.joinToString(" <- caused by: ") { "${it::class.java.name}: ${it.message}" }
    }

    /** True only if the alias exists AND is actually usable (a real
     * private key + certificate can be retrieved) -- not merely present.
     * Directly relevant to in-place app updates that preserve Keystore
     * state across a run: the pre-fix code could leave a partial/broken
     * alias behind after a failed generateKeyPair() call, and a bare
     * containsAlias() check would then wrongly treat that broken entry
     * as "already have a key," skipping regeneration entirely on the
     * very next launch -- silently reusing something unusable instead of
     * exercising the fallback fix at all. */
    private fun existingKeyIsUsable(ks: KeyStore): Boolean {
        if (!ks.containsAlias(KEYSTORE_ALIAS)) return false
        return try {
            val key = ks.getKey(KEYSTORE_ALIAS, null) as? java.security.PrivateKey ?: return false
            val cert = ks.getCertificate(KEYSTORE_ALIAS) ?: return false
            cert.publicKey != null && key.algorithm.isNotEmpty()
        } catch (e: Exception) {
            Log.w(LOG_TAG, "Existing keystore alias is present but not usable, will regenerate: ${describeException(e)}")
            false
        }
    }

    /** Generates the key if it doesn't already exist AND usable. Idempotent. */
    fun ensureKeyExists() {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (existingKeyIsUsable(ks)) return
        if (ks.containsAlias(KEYSTORE_ALIAS)) {
            // Present but unusable (see existingKeyIsUsable doc) -- clear
            // it before regenerating rather than colliding with it.
            try {
                ks.deleteEntry(KEYSTORE_ALIAS)
            } catch (e: KeyStoreException) {
                Log.w(LOG_TAG, "Could not clear an unusable pre-existing keystore entry: ${describeException(e)}")
            }
        }

        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        val baseSpec = KeyGenParameterSpec.Builder(KEYSTORE_ALIAS, KeyProperties.PURPOSE_SIGN)
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))

        val strongBoxFailure: Throwable
        try {
            kpg.initialize(baseSpec.setIsStrongBoxBacked(true).build())
            kpg.generateKeyPair()
            return // StrongBox path succeeded.
        } catch (e: StrongBoxUnavailableException) {
            // The documented, specific "this device has no StrongBox"
            // signal -- always safe to fall back.
            strongBoxFailure = e
        } catch (e: ProviderException) {
            // Real-device fragmentation: StrongBoxUnavailableException
            // extends ProviderException, but several OEM keymaster/
            // keymint HALs (observed in practice, including on real
            // Motorola hardware -- this exact fallback path is what this
            // class was missing before this fix) throw the broader
            // ProviderException("Failed to generate key pair") directly
            // instead of the documented specific subclass when StrongBox
            // key generation fails. Narrowly catching only
            // StrongBoxUnavailableException let this propagate uncaught.
            Log.w(LOG_TAG, "StrongBox key generation failed with a generic ProviderException (not the specific StrongBoxUnavailableException subclass) -- falling back to non-StrongBox: ${describeException(e)}")
            strongBoxFailure = e
        }

        // Some devices leave an inconsistent/partial alias entry behind
        // after a failed generateKeyPair() call; clear it defensively
        // before the fallback attempt so a stale entry from the failed
        // StrongBox attempt can't also make the fallback fail.
        try {
            if (ks.containsAlias(KEYSTORE_ALIAS)) ks.deleteEntry(KEYSTORE_ALIAS)
        } catch (e: KeyStoreException) {
            Log.w(LOG_TAG, "Could not clear a possibly-partial keystore entry before fallback: ${describeException(e)}")
        }

        try {
            kpg.initialize(baseSpec.setIsStrongBoxBacked(false).build())
            kpg.generateKeyPair()
        } catch (fallbackFailure: Exception) {
            throw KeyGenerationFailedException(
                "Device key generation failed on BOTH the StrongBox and non-StrongBox path. " +
                    "StrongBox attempt: ${describeException(strongBoxFailure)}. " +
                    "Fallback attempt: ${describeException(fallbackFailure)}."
            )
        }
    }

    /** Standard padded base64 of the DER SubjectPublicKeyInfo, per contract. */
    fun exportPublicKeySpkiBase64(): String {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val cert = ks.getCertificate(KEYSTORE_ALIAS)
        val spkiDer = cert.publicKey.encoded // already SPKI DER for a KeyStore EC public key
        return Base64.encodeToString(spkiDer, Base64.NO_WRAP)
    }

    /**
     * Signs the exact UTF-8 bytes of [signingPayload] (contract: "do not
     * reconstruct JSON or concatenate fields" -- the caller must pass the
     * server-returned string verbatim), and returns base64-encoded fixed
     * 64-byte IEEE P1363 signature bytes, per contract
     * (signatureEncoding: 'base64-p1363').
     */
    fun signPayload(signingPayload: String): String {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val privateKey = ks.getKey(KEYSTORE_ALIAS, null) as java.security.PrivateKey
        val sig = Signature.getInstance("SHA256withECDSA")
        sig.initSign(privateKey)
        sig.update(signingPayload.toByteArray(Charsets.UTF_8))
        val derSignature = sig.sign()
        val p1363 = EcdsaSignatureCodec.derToP1363(derSignature)
        return Base64.encodeToString(p1363, Base64.NO_WRAP)
    }

    /** Best-effort, self-reported only -- see class doc. */
    fun keySecurityLevel(): String {
        return try {
            val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            val key = ks.getKey(KEYSTORE_ALIAS, null) as java.security.PrivateKey
            val factory = KeyFactory.getInstance(key.algorithm, ANDROID_KEYSTORE)
            val keyInfo = factory.getKeySpec(key, KeyInfo::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                when (keyInfo.securityLevel) {
                    KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
                    KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
                    KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
                    else -> "unknown"
                }
            } else {
                if (keyInfo.isInsideSecureHardware) "tee" else "software"
            }
        } catch (e: Exception) {
            "unknown"
        }
    }

    /** SHA-256 of this app's own signing certificate, lowercase hex, per contract. */
    fun signingCertSha256(): String {
        @Suppress("DEPRECATION")
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            context.packageManager.getPackageInfo(
                context.packageName, PackageManager.GET_SIGNING_CERTIFICATES
            ).signingInfo!!.apkContentsSigners[0]
        } else {
            context.packageManager.getPackageInfo(
                context.packageName, PackageManager.GET_SIGNATURES
            ).signatures!![0]
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(info.toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }

    fun packageName(): String = context.packageName
}
