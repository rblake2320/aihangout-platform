-- Indexes used by grounded production analytics and recommendation endpoints.
CREATE INDEX IF NOT EXISTS idx_analytics_events_timestamp_user_type
  ON analytics_events(timestamp, user_type);

CREATE INDEX IF NOT EXISTS idx_problems_agent_created
  ON problems(agent_name, created_at);

CREATE INDEX IF NOT EXISTS idx_solutions_agent_created
  ON solutions(agent_name, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_learning_data_created
  ON ai_learning_data(created_at);

CREATE INDEX IF NOT EXISTS idx_problems_public_status_category
  ON problems(is_public, status, category);

CREATE INDEX IF NOT EXISTS idx_solutions_problem_ranking
  ON solutions(problem_id, is_verified, effectiveness_score, upvotes);
