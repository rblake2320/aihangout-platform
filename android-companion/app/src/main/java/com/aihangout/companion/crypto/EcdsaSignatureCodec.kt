package com.aihangout.companion.crypto

/**
 * Converts an ASN.1 DER-encoded ECDSA signature (what Android's
 * Signature.getInstance("SHA256withECDSA") produces) into the fixed
 * 64-byte IEEE P1363 r||s format the backend's enrollment contract
 * requires (each of r and s as an unsigned big-endian integer, zero-
 * padded to exactly 32 bytes for the P-256 curve).
 *
 * Strict parser per Team/tasks/A1-to-A3-enrollment-contract-20260908.md:
 * rejects trailing bytes after the SEQUENCE, non-minimal (extra leading
 * zero padding) integer encodings, negative-encoded integers, and
 * integers whose unsigned value would not fit P-256's 32-byte field
 * size. A well-formed signature from Android's own Signature API should
 * never violate any of these -- this is defensive validation of our own
 * crypto output, not tolerance for malformed input.
 *
 * Correctness was verified end-to-end, not just by inspection: a real
 * EC P-256 key + signature was generated, converted with the same
 * algorithm implemented here (cross-checked in Python), and the
 * resulting P1363 bytes were independently verified as a VALID signature
 * over the original message against the original public key using
 * Node's crypto.verify(..., {dsaEncoding: 'ieee-p1363'}) -- see this
 * project's design-review receipts.
 */
object EcdsaSignatureCodec {
    private const val FIELD_SIZE = 32 // P-256

    class DerFormatException(message: String) : Exception(message)

    fun derToP1363(der: ByteArray): ByteArray {
        var pos = 0

        fun requireByte(expected: Int, what: String) {
            if (pos >= der.size) throw DerFormatException("truncated reading $what")
            val b = der[pos].toInt() and 0xFF
            if (b != expected) throw DerFormatException("expected $what tag 0x${expected.toString(16)}, got 0x${b.toString(16)}")
            pos++
        }

        fun readLength(): Int {
            if (pos >= der.size) throw DerFormatException("truncated reading length")
            val first = der[pos].toInt() and 0xFF
            pos++
            if (first < 0x80) return first
            // Long-form length -- not expected for a P-256 signature (max
            // content is well under 128 bytes so short form always
            // suffices), but handled correctly rather than silently
            // mis-parsed if it were ever to appear.
            val numBytes = first and 0x7F
            if (numBytes == 0 || numBytes > 4) throw DerFormatException("unsupported DER length encoding")
            var len = 0
            repeat(numBytes) {
                if (pos >= der.size) throw DerFormatException("truncated reading long-form length")
                len = (len shl 8) or (der[pos].toInt() and 0xFF)
                pos++
            }
            return len
        }

        fun readInteger(): ByteArray {
            requireByte(0x02, "INTEGER")
            val len = readLength()
            if (len <= 0) throw DerFormatException("INTEGER has non-positive length")
            if (pos + len > der.size) throw DerFormatException("INTEGER length exceeds remaining buffer")
            val raw = der.copyOfRange(pos, pos + len)
            pos += len
            // Reject a negative-encoded integer (MSB set with no leading
            // zero pad) -- ECDSA r/s are always positive.
            if (raw.isNotEmpty() && (raw[0].toInt() and 0x80) != 0) {
                throw DerFormatException("INTEGER encodes a negative value, invalid for ECDSA r/s")
            }
            // Reject non-minimal encoding: a leading zero byte is only
            // valid DER when the NEXT byte's high bit is set (i.e. the pad
            // was actually needed to keep the value non-negative).
            if (raw.size >= 2 && raw[0] == 0.toByte() && (raw[1].toInt() and 0x80) == 0) {
                throw DerFormatException("INTEGER has non-minimal (unnecessary leading zero) encoding")
            }
            return raw
        }

        requireByte(0x30, "SEQUENCE")
        val seqLen = readLength()
        val seqStart = pos
        if (seqStart + seqLen != der.size) {
            throw DerFormatException("trailing bytes after SEQUENCE (declared len=$seqLen, actual remaining=${der.size - seqStart})")
        }
        val r = readInteger()
        val s = readInteger()
        if (pos != der.size) {
            throw DerFormatException("trailing bytes after r/s INTEGERs")
        }

        return toFixedWidth(r) + toFixedWidth(s)
    }

    private fun toFixedWidth(unsignedBigEndian: ByteArray): ByteArray {
        // Strip a single DER sign-disambiguation zero-pad byte if present.
        val trimmed = when {
            unsignedBigEndian.size > FIELD_SIZE + 1 ->
                throw DerFormatException("integer overlong for P-256 field size (${unsignedBigEndian.size} bytes)")
            unsignedBigEndian.size == FIELD_SIZE + 1 -> {
                if (unsignedBigEndian[0] != 0.toByte()) {
                    throw DerFormatException("integer overlong for P-256 field size and not a valid sign-pad byte")
                }
                unsignedBigEndian.copyOfRange(1, unsignedBigEndian.size)
            }
            else -> unsignedBigEndian
        }
        val out = ByteArray(FIELD_SIZE)
        System.arraycopy(trimmed, 0, out, FIELD_SIZE - trimmed.size, trimmed.size)
        return out
    }
}
