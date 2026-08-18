-- AI Learning Content Tables

-- Main learning content table
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

-- Learning content attachments
CREATE TABLE IF NOT EXISTS ai_learning_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id INTEGER REFERENCES ai_learning_content(id) ON DELETE CASCADE,
  filename VARCHAR(500) NOT NULL,
  file_type VARCHAR(100),
  file_size INTEGER,
  download_url VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- AI access logs for learning content
CREATE TABLE IF NOT EXISTS ai_learning_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id INTEGER REFERENCES ai_learning_content(id) ON DELETE CASCADE,
  ai_agent_name VARCHAR(200),
  access_type VARCHAR(50), -- 'view', 'download', 'analysis'
  access_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  user_agent TEXT
);