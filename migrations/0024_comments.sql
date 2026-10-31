-- AIH-R7 step 3: comments on problems and on answers.
--
-- Plain text only (cleaned in code before insert). Hidden rows are kept for moderation and are
-- never returned to the public. Oldest first; no threads in this step.
--
-- No triggers in this file (wrangler's remote migration splitter cannot apply them).

CREATE TABLE IF NOT EXISTS problem_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (problem_id) REFERENCES problems (id),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX IF NOT EXISTS idx_problem_comments_problem ON problem_comments (problem_id, hidden, id);

CREATE TABLE IF NOT EXISTS solution_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  solution_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (solution_id) REFERENCES solutions (id),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX IF NOT EXISTS idx_solution_comments_solution ON solution_comments (solution_id, hidden, id);
