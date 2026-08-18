-- Enhanced Analytics and Session Tracking Schema

-- Analytics events for comprehensive logging
CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type VARCHAR(50) NOT NULL, -- 'page_view', 'user_login', 'chat_message', 'problem_post', etc.
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_type VARCHAR(20), -- 'human', 'ai_agent', 'anonymous'
  session_id VARCHAR(500),
  page_url VARCHAR(500),
  referrer VARCHAR(500),
  user_agent TEXT,
  ip_address VARCHAR(45),
  event_data JSON, -- Additional event-specific data
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- User activity summary for quick analytics
CREATE TABLE IF NOT EXISTS user_activity_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  page_views INTEGER DEFAULT 0,
  chat_messages INTEGER DEFAULT 0,
  problems_posted INTEGER DEFAULT 0,
  solutions_posted INTEGER DEFAULT 0,
  votes_cast INTEGER DEFAULT 0,
  time_spent_minutes INTEGER DEFAULT 0,
  UNIQUE(user_id, date)
);

-- Enhanced active sessions with better tracking
ALTER TABLE active_sessions ADD COLUMN activity_score FLOAT DEFAULT 0;
ALTER TABLE active_sessions ADD COLUMN last_action VARCHAR(100) DEFAULT 'page_visit';
ALTER TABLE active_sessions ADD COLUMN page_count INTEGER DEFAULT 1;

-- Platform usage metrics
CREATE TABLE IF NOT EXISTS platform_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_date DATE NOT NULL UNIQUE,
  total_users INTEGER DEFAULT 0,
  active_users INTEGER DEFAULT 0,
  ai_agents INTEGER DEFAULT 0,
  human_users INTEGER DEFAULT 0,
  new_registrations INTEGER DEFAULT 0,
  total_problems INTEGER DEFAULT 0,
  total_solutions INTEGER DEFAULT 0,
  chat_messages INTEGER DEFAULT 0,
  page_views INTEGER DEFAULT 0
);

-- Real-time metrics for live dashboard
CREATE TABLE IF NOT EXISTS realtime_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_name VARCHAR(100) NOT NULL UNIQUE,
  metric_value FLOAT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert initial real-time metrics
INSERT OR IGNORE INTO realtime_metrics (metric_name, metric_value) VALUES
('users_online_now', 0),
('ai_agents_online', 0),
('humans_online', 0),
('messages_last_hour', 0),
('problems_today', 0),
('platform_load_score', 0);

-- Indexes for analytics performance
CREATE INDEX IF NOT EXISTS idx_analytics_events_type_time ON analytics_events(event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user ON analytics_events(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session ON analytics_events(session_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_user_activity_date ON user_activity_summary(date DESC);
CREATE INDEX IF NOT EXISTS idx_platform_metrics_date ON platform_metrics(metric_date DESC);