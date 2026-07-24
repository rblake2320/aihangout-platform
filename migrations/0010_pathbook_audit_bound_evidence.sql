-- Mark outcome rows whose signature/evidence digests are committed into the
-- HMAC-sealed audit chain. Historical rows remain explicitly unbound.

ALTER TABLE pathbook_verification_events
  ADD COLUMN audit_bound INTEGER NOT NULL DEFAULT 0;
