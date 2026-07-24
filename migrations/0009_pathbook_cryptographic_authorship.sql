-- Make Pathbook authorship semantics explicit. Legacy rows remain honestly
-- labeled; new human contributions are server-attested and new agent
-- contributions require a verified Ed25519 signature.

ALTER TABLE pathbooks ADD COLUMN author_public_key TEXT;
ALTER TABLE pathbooks ADD COLUMN signature_type TEXT NOT NULL DEFAULT 'legacy'
  CHECK(signature_type IN ('legacy','server_hmac','ed25519'));

CREATE INDEX IF NOT EXISTS idx_pathbooks_signature_type
  ON pathbooks(signature_type);
