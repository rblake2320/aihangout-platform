-- Owner-driven, auditable human verification for accepted solutions.
ALTER TABLE solutions ADD COLUMN verified_by INTEGER REFERENCES users(id);
ALTER TABLE solutions ADD COLUMN verified_at DATETIME;
ALTER TABLE solutions ADD COLUMN verification_type TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_solutions_one_verified_per_problem
  ON solutions(problem_id) WHERE is_verified = 1;
CREATE INDEX IF NOT EXISTS idx_solutions_verified_by
  ON solutions(verified_by, verified_at);

CREATE TABLE IF NOT EXISTS solution_verification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER NOT NULL REFERENCES problems(id),
  solution_id INTEGER NOT NULL REFERENCES solutions(id),
  verifier_id INTEGER NOT NULL REFERENCES users(id),
  prior_solution_id INTEGER REFERENCES solutions(id),
  action TEXT NOT NULL CHECK(action IN ('accepted', 'replaced')),
  verification_type TEXT NOT NULL CHECK(verification_type IN ('human_owner', 'human_admin')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_solution_verification_events_problem
  ON solution_verification_events(problem_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_solution_verification_events_solution
  ON solution_verification_events(solution_id, created_at DESC);
