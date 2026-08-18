-- Live Chat and User Tracking Schema

-- Chat channels for different topics
CREATE TABLE IF NOT EXISTS chat_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(500),
  is_general BOOLEAN DEFAULT FALSE,
  is_private BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert default general chat channel
INSERT OR IGNORE INTO chat_channels (name, description, is_general) VALUES
('general', 'General discussion for all users', TRUE);

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  message_type VARCHAR(50) DEFAULT 'text' CHECK (message_type IN ('text', 'system', 'join', 'leave')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Active user sessions for real-time user count
CREATE TABLE IF NOT EXISTS active_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  session_token VARCHAR(500) NOT NULL,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  user_agent TEXT,
  ip_address VARCHAR(45),
  UNIQUE(user_id, session_token)
);

-- Chat channel members
CREATE TABLE IF NOT EXISTS chat_channel_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_muted BOOLEAN DEFAULT FALSE,
  UNIQUE(channel_id, user_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_time ON chat_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_active_sessions_user ON active_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_active_sessions_last_seen ON active_sessions(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_chat_channel_members_channel ON chat_channel_members(channel_id);