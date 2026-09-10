-- Preserve historical applications while making every new remediation issue
-- auditable as either ordinary trusted execution or an explicitly authorized
-- isolated test scope. NULL on older rows means no scope was asserted.

ALTER TABLE pathbook_applications
  ADD COLUMN execution_scope TEXT NOT NULL DEFAULT 'legacy'
    CHECK(execution_scope IN ('legacy', 'normal', 'authorized_test_scope'));

ALTER TABLE pathbook_applications
  ADD COLUMN authorized_test_scope_id TEXT;

CREATE INDEX IF NOT EXISTS idx_pathbook_applications_execution_scope
  ON pathbook_applications(execution_scope, issued_at DESC);
