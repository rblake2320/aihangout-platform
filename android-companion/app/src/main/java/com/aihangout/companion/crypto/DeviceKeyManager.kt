package com.aihangout.companion.crypto

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
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
    }

    /** Generates the key if it doesn't already exist. Idempotent. */
    fun ensureKeyExists() {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (ks.containsAlias(KEYSTORE_ALIAS)) return

        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        val baseSpec = KeyGenParameterSpec.Builder(KEYSTORE_ALIAS, KeyProperties.PURPOSE_SIGN)
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))

        try {
            kpg.initialize(baseSpec.setIsStrongBoxBacked(true).build())
        } catch (e: StrongBoxUnavailableException) {
            kpg.initialize(baseSpec.setIsStrongBoxBacked(false).build())
        }
        kpg.generateKeyPair()
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
