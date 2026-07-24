-- Baseline: production schema snapshot 2026-07-23. Applied-as-recorded on prod (schema pre-existed).
CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      reputation INTEGER DEFAULT 0,
      join_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      ai_agent_type TEXT DEFAULT 'human'
    , is_admin BOOLEAN DEFAULT FALSE);
CREATE TABLE IF NOT EXISTS problems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT,
      difficulty TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'open',
      upvotes INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ai_context TEXT,
      spof_indicators TEXT, bounty_amount INTEGER DEFAULT 0, tags TEXT, source_url TEXT, external_id TEXT, is_harvested BOOLEAN DEFAULT FALSE, estimated_value INTEGER DEFAULT 0, impact_level TEXT DEFAULT 'medium', affected_users INTEGER DEFAULT 100, time_to_solve TEXT DEFAULT '2-5 days', industry TEXT DEFAULT 'Technology', is_public BOOLEAN DEFAULT TRUE, moderation_score REAL DEFAULT 1.0, report_count INTEGER DEFAULT 0, moderation_flag TEXT, solver_type TEXT DEFAULT 'human', agent_name TEXT, content_flags TEXT DEFAULT '{"flagged":false,"patterns":[],"risk":"none"}',
      FOREIGN KEY (user_id) REFERENCES users (id)
    );
CREATE TABLE IF NOT EXISTS solutions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      problem_id INTEGER,
      user_id INTEGER,
      solution_text TEXT NOT NULL,
      code_snippet TEXT,
      upvotes INTEGER DEFAULT 0,
      is_verified BOOLEAN DEFAULT FALSE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      why_explanation TEXT,
      effectiveness_score REAL, report_count INTEGER DEFAULT 0, moderation_flag TEXT, moderation_score REAL DEFAULT 0.0, solver_type TEXT DEFAULT 'human', agent_name TEXT, content_flags TEXT DEFAULT '{"flagged":false,"patterns":[],"risk":"none"}',
      FOREIGN KEY (problem_id) REFERENCES problems (id),
      FOREIGN KEY (user_id) REFERENCES users (id)
    );
CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      target_type TEXT, -- 'problem' or 'solution'
      target_id INTEGER,
      vote_type TEXT, -- 'up' or 'down'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    );
CREATE TABLE IF NOT EXISTS ai_learning_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      problem_id INTEGER,
      solution_id INTEGER,
      problem_vector TEXT, -- JSON encoded problem features
      solution_vector TEXT, -- JSON encoded solution features
      why_vector TEXT, -- JSON encoded WHY reasoning
      spof_categories TEXT, -- JSON encoded SPOF categories
      learning_weight REAL DEFAULT 1.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (problem_id) REFERENCES problems (id),
      FOREIGN KEY (solution_id) REFERENCES solutions (id)
    );
CREATE TABLE IF NOT EXISTS ai_learning_content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title VARCHAR(500) NOT NULL,
  content_type VARCHAR(50) NOT NULL CHECK (content_type IN ('blueprint', 'paper', 'research', 'model_card', 'documentation', 'launchable', 'overview', 'notes')),
  content TEXT NOT NULL,
  summary VARCHAR(1000),
  author_company VARCHAR(200),
  author_name VARCHAR(200),
  version VARCHAR(50),
  tags TEXT, -- JSON array of tags
  category VARCHAR(100),
  difficulty VARCHAR(20) CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
  is_featured BOOLEAN DEFAULT FALSE,
  is_nvidia_content BOOLEAN DEFAULT FALSE,
  access_level VARCHAR(20) DEFAULT 'public' CHECK (access_level IN ('public', 'restricted', 'company_only')),
  ai_accessible BOOLEAN DEFAULT TRUE,
  download_url VARCHAR(500),
  external_url VARCHAR(500),
  upvotes INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ai_learning_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id INTEGER REFERENCES ai_learning_content(id) ON DELETE CASCADE,
  filename VARCHAR(500) NOT NULL,
  file_type VARCHAR(100),
  file_size INTEGER,
  download_url VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ai_learning_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id INTEGER REFERENCES ai_learning_content(id) ON DELETE CASCADE,
  ai_agent_name VARCHAR(200),
  access_type VARCHAR(50), -- 'view', 'download', 'analysis'
  access_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS chat_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(500),
  is_general BOOLEAN DEFAULT FALSE,
  is_private BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  message_type VARCHAR(50) DEFAULT 'text' CHECK (message_type IN ('text', 'system', 'join', 'leave')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS active_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  session_token VARCHAR(500) NOT NULL,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  user_agent TEXT,
  ip_address VARCHAR(45),
  UNIQUE(user_id, session_token)
);
CREATE TABLE IF NOT EXISTS chat_channel_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_muted BOOLEAN DEFAULT FALSE,
  UNIQUE(channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_time ON chat_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_active_sessions_user ON active_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_active_sessions_last_seen ON active_sessions(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_chat_channel_members_channel ON chat_channel_members(channel_id);
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
CREATE TABLE IF NOT EXISTS enhanced_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  session_token VARCHAR(500) NOT NULL,
  user_type VARCHAR(20) DEFAULT 'human', -- 'human', 'ai_agent'
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  activity_score FLOAT DEFAULT 0,
  last_action VARCHAR(100) DEFAULT 'page_visit',
  page_count INTEGER DEFAULT 1,
  user_agent TEXT,
  ip_address VARCHAR(45),
  UNIQUE(user_id, session_token)
);
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
CREATE TABLE IF NOT EXISTS realtime_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_name VARCHAR(100) NOT NULL UNIQUE,
  metric_value FLOAT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_type_time ON analytics_events(event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user ON analytics_events(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session ON analytics_events(session_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_user_activity_date ON user_activity_summary(date DESC);
CREATE INDEX IF NOT EXISTS idx_platform_metrics_date ON platform_metrics(metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_enhanced_sessions_user ON enhanced_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_enhanced_sessions_last_seen ON enhanced_sessions(last_seen DESC);
CREATE TABLE IF NOT EXISTS external_problems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id VARCHAR(200) UNIQUE NOT NULL,
      source_site VARCHAR(50) NOT NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT NOT NULL,
      url VARCHAR(1000) NOT NULL,
      author VARCHAR(200),
      tags JSON,
      category VARCHAR(100),
      difficulty VARCHAR(20) DEFAULT 'medium',
      quality_score FLOAT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'available',
      assigned_agent_id INTEGER,
      assigned_at DATETIME,
      scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      solution_count INTEGER DEFAULT 0,
      cross_post_enabled BOOLEAN DEFAULT TRUE
    );
CREATE TABLE IF NOT EXISTS ai_intelligence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company TEXT NOT NULL,
        content_type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        url TEXT NOT NULL,
        published_date TEXT,
        importance_score REAL DEFAULT 0.5,
        tags TEXT,
        key_features TEXT,
        source_url TEXT,
        scraped_at TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
CREATE TABLE IF NOT EXISTS ai_releases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company TEXT NOT NULL,
        product_name TEXT NOT NULL,
        version TEXT,
        release_date TEXT,
        key_features TEXT,
        performance_improvements TEXT,
        breaking_changes TEXT,
        url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
CREATE TABLE IF NOT EXISTS ai_trends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trend_name TEXT NOT NULL,
        trend_score REAL DEFAULT 0.0,
        companies_involved TEXT,
        related_releases TEXT,
        related_research TEXT,
        first_detected TEXT,
        last_updated TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
CREATE TABLE IF NOT EXISTS ai_intelligence_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        intelligence_id INTEGER NOT NULL,
        user_id INTEGER,
        ip_address TEXT,
        viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (intelligence_id) REFERENCES ai_intelligence (id),
        FOREIGN KEY (user_id) REFERENCES users (id)
      );
CREATE TABLE IF NOT EXISTS ai_intelligence_harvest_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        harvest_id TEXT NOT NULL,
        company TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        items_harvested INTEGER DEFAULT 0,
        force_refresh BOOLEAN DEFAULT FALSE,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
CREATE TABLE IF NOT EXISTS data_ownership_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id VARCHAR(255) NOT NULL,
        user_id INTEGER,
        event_type VARCHAR(100) NOT NULL,
        category VARCHAR(50) NOT NULL,
        event_data TEXT NOT NULL,
        metadata TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        competitive_value_score FLOAT DEFAULT 1.0,
        patent_evidence BOOLEAN DEFAULT TRUE
      );
CREATE TABLE IF NOT EXISTS search_analytics_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id VARCHAR(255) NOT NULL,
        user_id INTEGER,
        user_type VARCHAR(20) DEFAULT 'anonymous',
        query TEXT NOT NULL,
        filters TEXT,
        results_count INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        user_actions TEXT,
        success_indicators TEXT,
        ai_optimization_data TEXT
      );
CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content_type TEXT NOT NULL, -- 'problem', 'solution', 'learning'
      content_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id),
      UNIQUE(user_id, content_type, content_id)
    );
CREATE TABLE IF NOT EXISTS bug_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      bug_type TEXT NOT NULL,
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'open',
      steps_to_reproduce TEXT,
      expected_behavior TEXT,
      actual_behavior TEXT,
      user_agent TEXT,
      url TEXT,
      additional_info TEXT,
      user_id INTEGER,
      username TEXT DEFAULT 'Anonymous',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users (id)
    );
CREATE TABLE IF NOT EXISTS live_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id)
    );
CREATE TABLE IF NOT EXISTS guest_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE,
        ip_address TEXT,
        user_agent TEXT,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        page_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
CREATE TABLE IF NOT EXISTS major_problems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT,
      industry TEXT,
      impact_level TEXT DEFAULT 'medium',
      estimated_value INTEGER DEFAULT 0,
      affected_users INTEGER DEFAULT 0,
      time_to_solve TEXT,
      source TEXT DEFAULT 'community',
      bounty_amount INTEGER DEFAULT 0,
      is_featured BOOLEAN DEFAULT FALSE,
      tags TEXT,
      difficulty TEXT DEFAULT 'intermediate',
      company TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE IF NOT EXISTS followers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      follower_id INTEGER NOT NULL,
      following_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(follower_id, following_id),
      CHECK(follower_id != following_id),
      FOREIGN KEY (follower_id) REFERENCES users (id),
      FOREIGN KEY (following_id) REFERENCES users (id)
    );
CREATE TABLE IF NOT EXISTS platform_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      release_type TEXT DEFAULT 'minor',
      features TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE INDEX IF NOT EXISTS idx_followers_following ON followers(following_id);
CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      method VARCHAR(10),
      path VARCHAR(500),
      status INTEGER,
      duration_ms INTEGER,
      user_agent TEXT,
      ip_address VARCHAR(45),
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE INDEX IF NOT EXISTS idx_analytics_type_ts ON analytics_events(event_type, timestamp);
CREATE INDEX IF NOT EXISTS idx_analytics_user_ts ON analytics_events(user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_request_log_path_ts ON request_log(path, timestamp);
CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      actor_id INTEGER,
      target_type TEXT,
      target_id INTEGER,
      message TEXT NOT NULL,
      is_read BOOLEAN DEFAULT FALSE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, actor_id, type, target_type, target_id),
      FOREIGN KEY (user_id) REFERENCES users (id),
      FOREIGN KEY (actor_id) REFERENCES users (id)
    );
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read, created_at);
CREATE TABLE IF NOT EXISTS user_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      notify_new_follower BOOLEAN DEFAULT TRUE,
      notify_vote_on_content BOOLEAN DEFAULT TRUE,
      notify_new_solution BOOLEAN DEFAULT TRUE,
      email_notifications BOOLEAN DEFAULT FALSE,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    );
CREATE TABLE IF NOT EXISTS content_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER NOT NULL,
      content_type TEXT NOT NULL CHECK(content_type IN ('problem','solution')),
      content_id INTEGER NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN ('spam','misleading','offensive','injection','other')),
      details TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','reviewed','dismissed','actioned')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(reporter_id, content_type, content_id),
      FOREIGN KEY (reporter_id) REFERENCES users(id)
    );
CREATE INDEX IF NOT EXISTS idx_reports_content ON content_reports(content_type, content_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON content_reports(status, created_at DESC);
CREATE TABLE IF NOT EXISTS agent_request_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        ip_address TEXT,
        user_id INTEGER,
        content_type TEXT,
        content_id INTEGER,
        action TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
CREATE INDEX IF NOT EXISTS idx_agent_log_name_ts ON agent_request_log(agent_name, created_at);
CREATE TABLE IF NOT EXISTS service_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        last_used_at TEXT
      , revoked_at TEXT);
CREATE TABLE IF NOT EXISTS pathbooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pathbook_id TEXT NOT NULL UNIQUE,
      protocol_version TEXT NOT NULL DEFAULT 'pbp-0.1',
      title TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','deprecated','dangerous')),
      trust_tier TEXT NOT NULL DEFAULT 'draft' CHECK(trust_tier IN ('draft','reproduced','verified','community_confirmed','maintainer_approved','deprecated','dangerous')),
      ecosystem TEXT,
      runtime TEXT,
      package_name TEXT,
      error_fingerprint TEXT NOT NULL,
      error_signature TEXT NOT NULL,
      trigger_yaml TEXT NOT NULL,
      remediation_yaml TEXT NOT NULL,
      verify_yaml TEXT,
      failed_attempts_yaml TEXT,
      provenance TEXT,
      signature TEXT,
      source_type TEXT DEFAULT 'community',
      source_url TEXT,
      times_applied INTEGER DEFAULT 0,
      times_succeeded INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0.2,
      token_savings_estimate INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
CREATE INDEX IF NOT EXISTS idx_pathbooks_fingerprint ON pathbooks(error_fingerprint);
CREATE INDEX IF NOT EXISTS idx_pathbooks_runtime_trust ON pathbooks(runtime, trust_tier, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_pathbooks_status_created ON pathbooks(status, created_at DESC);