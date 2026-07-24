"""Signing suite — proves signatures are enforced cryptography, not decorative
text: any tamper, wrong key, or malformed input fails closed (False), and
verification never raises on untrusted garbage."""

import pytest

from pathbook.signing import Keypair, canonical_bytes, verify_payload


@pytest.fixture()
def kp():
    return Keypair.generate()


PAYLOAD = {"id": "PB-1", "title": "fix", "n": 3, "nested": {"a": [1, 2]}}


class TestRoundtrip:
    def test_sign_verify_ok(self, kp):
        sig = kp.sign_payload(PAYLOAD)
        assert verify_payload(PAYLOAD, sig, kp.public_hex)

    def test_key_order_irrelevant(self, kp):
        sig = kp.sign_payload(PAYLOAD)
        reordered = {"nested": {"a": [1, 2]}, "n": 3, "title": "fix", "id": "PB-1"}
        assert verify_payload(reordered, sig, kp.public_hex)

    def test_private_key_roundtrip(self, kp):
        clone = Keypair.from_private_hex(kp.private_hex)
        assert clone.public_hex == kp.public_hex
        assert verify_payload(PAYLOAD, clone.sign_payload(PAYLOAD), kp.public_hex)


class TestTamper:
    def test_any_field_change_breaks(self, kp):
        sig = kp.sign_payload(PAYLOAD)
        for k, v in [("id", "PB-2"), ("title", "fix "), ("n", 4)]:
            tampered = dict(PAYLOAD, **{k: v})
            assert not verify_payload(tampered, sig, kp.public_hex)

    def test_nested_change_breaks(self, kp):
        sig = kp.sign_payload(PAYLOAD)
        tampered = dict(PAYLOAD, nested={"a": [1, 3]})
        assert not verify_payload(tampered, sig, kp.public_hex)

    def test_added_field_breaks(self, kp):
        sig = kp.sign_payload(PAYLOAD)
        assert not verify_payload(dict(PAYLOAD, extra=1), sig, kp.public_hex)

    def test_wrong_key_rejected(self, kp):
        sig = kp.sign_payload(PAYLOAD)
        other = Keypair.generate()
        assert not verify_payload(PAYLOAD, sig, other.public_hex)

    def test_bitflipped_signature_rejected(self, kp):
        sig = bytearray(bytes.fromhex(kp.sign_payload(PAYLOAD)))
        sig[0] ^= 0x01
        assert not verify_payload(PAYLOAD, bytes(sig).hex(), kp.public_hex)


class TestFailsClosed:
    def test_garbage_inputs_return_false_never_raise(self, kp):
        sig = kp.sign_payload(PAYLOAD)
        assert not verify_payload(PAYLOAD, "not-hex", kp.public_hex)
        assert not verify_payload(PAYLOAD, sig, "not-hex")
        assert not verify_payload(PAYLOAD, "ab" * 10, kp.public_hex)  # wrong length
        assert not verify_payload(PAYLOAD, sig, "ab" * 10)            # wrong length
        assert not verify_payload(PAYLOAD, "", "")

    def test_canonical_bytes_stable(self):
        a = canonical_bytes({"b": 1, "a": 2})
        b = canonical_bytes({"a": 2, "b": 1})
        assert a == b == b'{"a":2,"b":1}'
