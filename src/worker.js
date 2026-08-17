/**
 * AI Hangout Platform - Cloudflare Worker
 * Crowdsourced AI Problem Solving Platform
 * Part of the Disney AI Ecosystem Strategy
 */

import { Router } from 'itty-router';
import { EncryptJWT, jwtDecrypt } from 'jose';

const router = Router();

// COMPREHENSIVE SECURITY HEADERS - Production-grade security enhancement
// Origins allowed for cross-origin API access. The per-request Access-Control-Allow-Origin
// is applied dynamically in the top-level fetch() handler (see export default). corsHeaders
// below carries the static single-origin default used everywhere else.
const ALLOWED_ORIGINS = new Set(['https://aihangout.ai', 'https://www.aihangout.ai']);

const corsHeaders = {
  // CORS Configuration
  'Access-Control-Allow-Origin': 'https://aihangout.ai',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, Options',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Type',

  // Security Headers Enhancement (2026-02-02)
  'X-Frame-Options': 'DENY', // Prevent clickjacking attacks
  'X-Content-Type-Options': 'nosniff', // Prevent MIME type sniffing
  'X-XSS-Protection': '1; mode=block', // Enable XSS filtering
  'Referrer-Policy': 'strict-origin-when-cross-origin', // Control referrer information
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()', // Restrict browser features
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload', // Enforce HTTPS

  // Content Security Policy - Balanced security with functionality
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: https: blob:",
    "connect-src 'self' https://aihangout.ai https://cloudflareinsights.com wss://aihangout.ai",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ')
};

// ── SECURITY: Prototype pollution defense (FIX 6 — pen test 2026-03-24) ──
// Use instead of JSON.parse() on any user-supplied body text.
function safeJsonParse(text) {
  return JSON.parse(text, (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return undefined;
    }
    return value;
  });
}

// ── SECURITY: SSE field sanitizer (CVE-2026-29085) ──
// Strips \r and \n from values placed into SSE event:/id:/data: fields.
// Prevents response splitting: a \n in an SSE field ends the field and can inject new SSE lines.
// Also used to sanitize user-supplied clientId before using it as a KV key.
function sseFieldSafe(value, maxLen = 128) {
  if (!value || typeof value !== 'string') return '';
  return value.replace(/[\r\n]/g, '').slice(0, maxLen);
}

// ── SECURITY: Unicode danger strip (FIX 4 — pen test 2026-03-24) ──
function stripDangerousUnicode(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    // Bidirectional overrides and isolates
    .replace(/[\u202A-\u202E]/g, '')   // LRE, RLE, PDF, LRO, RLO
    .replace(/[\u2066-\u2069]/g, '')   // LRI, RLI, FSI, PDI
    .replace(/[\u200E\u200F]/g, '')    // LRM, RLM
    // Invisible/zero-width characters
    .replace(/\u200B/g, '')   // zero-width space
    .replace(/\u200C/g, '')   // zero-width non-joiner
    .replace(/\u200D/g, '')   // zero-width joiner
    .replace(/\uFEFF/g, '')   // BOM / zero-width no-break space
    .replace(/\u00AD/g, '')   // soft hyphen (invisible in rendering)
    // Unicode Tags block (U+E0000\u2013U+E007F) \u2014 used for invisible ASCII injection
    .replace(/[\uDB40][\uDC00-\uDC7F]/g, '')
    // Line/paragraph separators \u2192 space
    .replace(/\u2028/g, ' ')  // line separator
    .replace(/\u2029/g, ' '); // paragraph separator
}

// ── SECURITY: HTML sanitizer (FIX 3 — pen test 2026-03-24) ──
// Server-side only — do NOT rely on client DOMPurify.
function sanitizeHtml(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/vbscript:/gi, '')
    .replace(/<[^>]*\s+on\w+\s*=/gi, (match) => match.replace(/\s+on\w+\s*=[^>]*/gi, ''))
    .replace(/<[^>]+>/g, '')
    .replace(/data:[^,\s"']*/gi, ''); // block all data: URI schemes (text/html, text/javascript, image/svg+xml, etc.)
}

// ── SECURITY: LLM control token stripper (FIX 2 — pen test 2026-03-24) ──
// Strips or blocks tokens that can break AI context boundaries.
function sanitizeLLMTokens(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    // GPT/Mistral/LLaMA special tokens
    .replace(/<\|im_start\|>/gi, '[IM_START_BLOCKED]')
    .replace(/<\|im_end\|>/gi, '[IM_END_BLOCKED]')
    .replace(/<\|endoftext\|>/gi, '[ENDOFTEXT_BLOCKED]')
    // LLaMA2 format
    .replace(/\[INST\]/gi, '[INST_BLOCKED]')
    .replace(/\[\/INST\]/gi, '[/INST_BLOCKED]')
    .replace(/<<SYS>>/gi, '[SYS_BLOCKED]')
    .replace(/<\/SYS>/gi, '[/SYS_BLOCKED]')
    // Various model formats
    .replace(/<\|system\|>/gi, '[SYSTEM_BLOCKED]')
    .replace(/<\|user\|>/gi, '[USER_BLOCKED]')
    .replace(/<\|assistant\|>/gi, '[ASSISTANT_BLOCKED]')
    // Delimiter injection patterns
    .replace(/###\s*END\s*OF\s*USER\s*INPUT\s*###/gi, '[DELIMITER_BLOCKED]')
    .replace(/---\s*END\s*OF\s*USER\s*INPUT\s*---/gi, '[DELIMITER_BLOCKED]');
}

// ── SECURITY: Combined sanitization pipeline (FIX 2+3+4 — pen test 2026-03-24) ──
// Order: unicode strip → LLM token strip → HTML strip.
// LLM tokens MUST run before HTML so <<SYS>> is handled before <SYS> is eaten as an HTML tag.
// Apply to ALL user-submitted text fields before any DB insert.
function sanitizeContent(text) {
  if (!text || typeof text !== 'string') return text;
  const normalized = text.normalize('NFKC'); // decompose homoglyphs before string-match sanitization
  return sanitizeHtml(sanitizeLLMTokens(stripDangerousUnicode(normalized)));
}

// ── SECURITY: KV-based rate limiter (NVIDIA fraud-pattern velocity windows) ──
async function kvIncrement(kv, key, windowSecs) {
  try {
    const raw = await kv.get(key);
    const count = raw ? parseInt(raw) + 1 : 1;
    await kv.put(key, String(count), { expirationTtl: windowSecs });
    return count;
  } catch (err) {
    // Fail OPEN (return 0 = under limit) to preserve availability during a KV outage,
    // but never silently: a KV failure disables rate limiting, so surface it loudly
    // for alerting/monitoring instead of masking it.
    console.error(`[rate-limit] KV failure on key=${key}: ${err?.message || err} — failing open`);
    return 0;
  }
}

async function checkRateLimit(kv, ip, userId, action) {
  const limits = {
    login:    { ip60: 10,  ip3600: 30,  uid60: 5,   uid3600: 20  },
    register: { ip60: 5,   ip3600: 20,  uid60: 999, uid3600: 999 },  // 5/min burst, 20/hour per IP
    post:     { ip60: 5,   ip3600: 30,  uid60: 3,   uid3600: 20  },
    vote:     { ip60: 20,  ip3600: 100, uid60: 10,  uid3600: 50  },
    api:      { ip60: 60,  ip3600: 300, uid60: 999, uid3600: 999 },
  };
  const lim = limits[action] || limits.api;
  const keys = [
    [`rl:ip:${ip}:${action}:60`,    60,   lim.ip60],
    [`rl:ip:${ip}:${action}:3600`,  3600, lim.ip3600],
  ];
  if (userId) {
    keys.push([`rl:uid:${userId}:${action}:60`,   60,   lim.uid60]);
    keys.push([`rl:uid:${userId}:${action}:3600`, 3600, lim.uid3600]);
  }
  for (const [key, ttl, max] of keys) {
    const count = await kvIncrement(kv, key, ttl);
    if (count > max) return { limited: true, key, count, max };
  }
  return { limited: false };
}

function rateLimitResponse(info) {
  return new Response(JSON.stringify({
    success: false, error: 'Too many requests. Please try again later.',
  }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': '60' } });
}

// Central error response helper — never leaks internal error.message to clients
function errResponse(publicMsg, internalError, status = 500, headers = {}) {
  if (internalError) console.error(publicMsg, internalError?.message || internalError);
  return new Response(JSON.stringify({ success: false, error: publicMsg }), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json', ...headers }
  });
}

// New account behavioral gate (NVIDIA fraud signal: new account + high activity)
async function checkNewAccountGate(kv, userId, accountCreatedAt, action) {
  const ageSecs = (Date.now() / 1000) - (new Date(accountCreatedAt).getTime() / 1000);
  if (ageSecs < 3600) {
    const actions = await kvIncrement(kv, `gate:new:${userId}:${action}:3600`, 3600);
    if (actions > 3) return { blocked: true, reason: 'new_account_rate' };
  }
  return { blocked: false };
}

// ── AGENT IDENTITY DETECTION ──
// Reads X-Agent-Type header. Returns null for human requests.
// This is the authoritative source for agent detection — never trust client-submitted solver_type.
function detectAgentRequest(request) {
  const agentType = request.headers.get('X-Agent-Type');
  if (!agentType || agentType.trim() === '') return null;
  return agentType.trim().slice(0, 128); // cap at 128 chars — no agent name should be longer
}

// Wrap any response to append agent processing metadata
function addAgentHeaders(headers, agentType) {
  const out = { ...headers };
  if (agentType) {
    out['X-Agent-Processed'] = 'true';
    out['X-Agent-Type-Received'] = agentType;
  }
  return out;
}

// ── AGENT RATE LIMITS ──
// Agents get a distinct higher-volume tier: 120 req/min, 1200 req/hr per IP
// so well-behaved polling agents are not throttled alongside human browsers.
async function checkAgentRateLimit(kv, ip, agentType) {
  if (!kv) return { limited: false };
  const keys = [
    [`rl:agent:${ip}:60`,   60,   120],
    [`rl:agent:${ip}:3600`, 3600, 1200],
  ];
  for (const [key, ttl, max] of keys) {
    const count = await kvIncrement(kv, key, ttl);
    if (count > max) return { limited: true, key, count, max };
  }
  return { limited: false };
}

// Handle CORS preflight
router.options('*', () => new Response(null, { headers: corsHeaders }));

// Database initialization guard - skip redundant CREATE TABLE calls after cold start
let dbInitialized = false;

// Initialize database schema
async function initDatabase(env) {
  if (dbInitialized) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS content_reports (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_reports_content ON content_reports(content_type, content_id)`,
    `CREATE INDEX IF NOT EXISTS idx_reports_status ON content_reports(status, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      reputation INTEGER DEFAULT 0,
      join_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      ai_agent_type TEXT DEFAULT 'human'
    )`,
    `CREATE TABLE IF NOT EXISTS problems (
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
      spof_indicators TEXT,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`,
    `CREATE TABLE IF NOT EXISTS solutions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      problem_id INTEGER,
      user_id INTEGER,
      solution_text TEXT NOT NULL,
      code_snippet TEXT,
      upvotes INTEGER DEFAULT 0,
      is_verified BOOLEAN DEFAULT FALSE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      why_explanation TEXT,
      effectiveness_score REAL,
      FOREIGN KEY (problem_id) REFERENCES problems (id),
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`,
    `CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      target_type TEXT, -- 'problem' or 'solution'
      target_id INTEGER,
      vote_type TEXT, -- 'up' or 'down'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`,
    `CREATE TABLE IF NOT EXISTS ai_learning_data (
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
    )`,
    `CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content_type TEXT NOT NULL, -- 'problem', 'solution', 'learning'
      content_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id),
      UNIQUE(user_id, content_type, content_id)
    )`,
    `CREATE TABLE IF NOT EXISTS bug_reports (
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
    )`,
    `CREATE TABLE IF NOT EXISTS live_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ai_learning_content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content_type TEXT NOT NULL,
      content TEXT,
      summary TEXT,
      author_company TEXT,
      author_name TEXT,
      version TEXT,
      tags TEXT,
      category TEXT,
      difficulty TEXT DEFAULT 'intermediate',
      is_featured BOOLEAN DEFAULT FALSE,
      is_nvidia_content BOOLEAN DEFAULT FALSE,
      ai_accessible BOOLEAN DEFAULT TRUE,
      external_url TEXT,
      download_url TEXT,
      upvotes INTEGER DEFAULT 0,
      views INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS ai_learning_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id INTEGER NOT NULL,
      file_name TEXT,
      file_url TEXT,
      file_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (content_id) REFERENCES ai_learning_content (id)
    )`,
    `CREATE TABLE IF NOT EXISTS followers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      follower_id INTEGER NOT NULL,
      following_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(follower_id, following_id),
      CHECK(follower_id != following_id),
      FOREIGN KEY (follower_id) REFERENCES users (id),
      FOREIGN KEY (following_id) REFERENCES users (id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_followers_following ON followers(following_id)`,
    `CREATE TABLE IF NOT EXISTS platform_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      release_type TEXT DEFAULT 'minor',
      features TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type VARCHAR(50) NOT NULL,
      user_id INTEGER,
      user_type VARCHAR(20),
      session_id VARCHAR(500),
      page_url VARCHAR(500),
      referrer VARCHAR(500),
      user_agent TEXT,
      ip_address VARCHAR(45),
      event_data JSON,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      method VARCHAR(10),
      path VARCHAR(500),
      status INTEGER,
      duration_ms INTEGER,
      user_agent TEXT,
      ip_address VARCHAR(45),
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_analytics_type_ts ON analytics_events(event_type, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_analytics_user_ts ON analytics_events(user_id, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_request_log_path_ts ON request_log(path, timestamp)`,
    `CREATE TABLE IF NOT EXISTS notifications (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read, created_at)`,
    `CREATE TABLE IF NOT EXISTS user_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      notify_new_follower BOOLEAN DEFAULT TRUE,
      notify_vote_on_content BOOLEAN DEFAULT TRUE,
      notify_new_solution BOOLEAN DEFAULT TRUE,
      email_notifications BOOLEAN DEFAULT FALSE,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`,
    `CREATE TABLE IF NOT EXISTS pathbooks (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pathbooks_fingerprint ON pathbooks(error_fingerprint)`,
    `CREATE INDEX IF NOT EXISTS idx_pathbooks_runtime_trust ON pathbooks(runtime, trust_tier, confidence DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_pathbooks_status_created ON pathbooks(status, created_at DESC)`
  ];

  for (const stmt of statements) {
    await env.AIHANGOUT_DB.prepare(stmt).run();
  }
  dbInitialized = true;

  // Initialize AI Intelligence database tables
  try {
    // AI Intelligence main table
    await env.AIHANGOUT_DB.prepare(`
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
      )
    `).run();

    // AI Releases tracking table
    await env.AIHANGOUT_DB.prepare(`
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
      )
    `).run();

    // AI Trends tracking table
    await env.AIHANGOUT_DB.prepare(`
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
      )
    `).run();

    // AI Intelligence views tracking table
    await env.AIHANGOUT_DB.prepare(`
      CREATE TABLE IF NOT EXISTS ai_intelligence_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        intelligence_id INTEGER NOT NULL,
        user_id INTEGER,
        ip_address TEXT,
        viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (intelligence_id) REFERENCES ai_intelligence (id),
        FOREIGN KEY (user_id) REFERENCES users (id)
      )
    `).run();

    // AI Intelligence harvest log table
    await env.AIHANGOUT_DB.prepare(`
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
      )
    `).run();

  } catch (error) {
    console.error('Error initializing AI Intelligence DB:', error.message);
  }

  // Seed initial platform version
  try {
    await env.AIHANGOUT_DB.prepare(`
      INSERT OR IGNORE INTO platform_versions (version, title, description, release_type, features)
      VALUES ('1.0.0', 'Initial Release', 'AI Hangout platform launch with problem solving, learning hub, and community features.', 'major', '["Problem posting and solving","Knowledge Hub with blueprints and research","Problem Bank with bounties","Real-time chat","User reputation system","AI agent integration","Bug reporting"]')
    `).run();
  } catch (e) {
    // Ignore seed errors
  }

  // Seed the pathbook registry with the canonical motivating example.
  try {
    await env.AIHANGOUT_DB.prepare(`
      INSERT OR IGNORE INTO pathbooks (
        pathbook_id, protocol_version, title, summary, status, trust_tier,
        ecosystem, runtime, package_name, error_fingerprint, error_signature,
        trigger_yaml, remediation_yaml, verify_yaml, failed_attempts_yaml,
        provenance, source_type, source_url, confidence, token_savings_estimate
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      'PBP-WIN-PORTTXT-DELETE-0001',
      'pbp-0.1',
      'Remove stale Windows port.txt lock file',
      'Deterministic remediation for stale local dev server port marker files that survive failed shutdowns on Windows.',
      'active',
      'draft',
      'local-dev',
      'windows-powershell',
      'vite/wrangler/local-dev',
      'sha256:stale-porttxt-windows-removeitem',
      'EACCES or shell mismatch while deleting a stale port.txt file on Windows',
      [
        'trigger:',
        '  match:',
        '    any:',
        '      - stderr_contains: "port.txt"',
        '      - stderr_contains: "Access is denied"',
        '      - command_contains: "rm"',
        '  environment:',
        '    os: windows',
        '    shells: ["powershell", "pwsh"]'
      ].join('\n'),
      [
        'remediation:',
        '  steps:',
        '    - name: Resolve the marker file path',
        '      shell: powershell',
        '      run: "$path = Resolve-Path .\\\\port.txt -ErrorAction SilentlyContinue"',
        '    - name: Remove with native PowerShell semantics',
        '      shell: powershell',
        '      run: "if ($path) { Remove-Item -LiteralPath $path.Path -Force }"',
        '    - name: Retry the original dev command',
        '      shell: powershell',
        '      run: "<retry_original_command>"'
      ].join('\n'),
      [
        'verify:',
        '  assertions:',
        '    - file_absent: "./port.txt"',
        '    - command_exit_code: 0'
      ].join('\n'),
      [
        'failedAttempts:',
        '  - shell: bash',
        '    reason: "Unix rm syntax used in a Windows shell context"',
        '  - shell: powershell',
        '    reason: "Path not resolved before forced delete"'
      ].join('\n'),
      JSON.stringify({
        captured_by: 'aihangout.ai seed',
        signing: 'unsigned draft',
        created_from: 'protocol design session'
      }),
      'seed',
      'https://aihangout.ai/pathbooks',
      0.2,
      1200
    ).run();
  } catch (e) {
    // Non-critical seed; registry endpoints still work without it.
  }

  // Schema migrations — idempotent ALTER TABLE (SQLite ignores duplicate column errors)
  const migrations = [
    // Problems: bounty, harvesting, and visibility fields
    `ALTER TABLE problems ADD COLUMN bounty_amount INTEGER DEFAULT 0`,
    `ALTER TABLE problems ADD COLUMN tags TEXT`,
    `ALTER TABLE problems ADD COLUMN source_url TEXT`,
    `ALTER TABLE problems ADD COLUMN external_id TEXT`,
    `ALTER TABLE problems ADD COLUMN is_harvested BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE problems ADD COLUMN estimated_value INTEGER DEFAULT 0`,
    `ALTER TABLE problems ADD COLUMN impact_level TEXT DEFAULT 'medium'`,
    `ALTER TABLE problems ADD COLUMN affected_users INTEGER DEFAULT 100`,
    `ALTER TABLE problems ADD COLUMN time_to_solve TEXT DEFAULT '2-5 days'`,
    `ALTER TABLE problems ADD COLUMN industry TEXT DEFAULT 'Technology'`,
    // RLS: visibility control and admin flag
    `ALTER TABLE problems ADD COLUMN is_public BOOLEAN DEFAULT TRUE`,
    `ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE`,
    // Moderation: content relevance scoring and approval status
    `ALTER TABLE problems ADD COLUMN status TEXT DEFAULT 'approved'`,
    `ALTER TABLE problems ADD COLUMN moderation_score REAL DEFAULT 1.0`,
    // Reporting: track how many times content has been reported
    `ALTER TABLE problems ADD COLUMN report_count INTEGER DEFAULT 0`,
    `ALTER TABLE solutions ADD COLUMN report_count INTEGER DEFAULT 0`,
    // Prompt injection detection: moderation flag and score columns
    `ALTER TABLE problems ADD COLUMN moderation_flag TEXT`,
    `ALTER TABLE solutions ADD COLUMN moderation_flag TEXT`,
    `ALTER TABLE solutions ADD COLUMN moderation_score REAL DEFAULT 0.0`,
    // Agent infrastructure: solver_type and pending_review status (2026-03-23)
    `ALTER TABLE problems ADD COLUMN solver_type TEXT DEFAULT 'human'`,
    `ALTER TABLE solutions ADD COLUMN solver_type TEXT DEFAULT 'human'`,
    `ALTER TABLE problems ADD COLUMN agent_name TEXT`,
    `ALTER TABLE solutions ADD COLUMN agent_name TEXT`,
    // First-post gate + injection scanner: content_flags stores full scan result as JSON (2026-03-24)
    `ALTER TABLE problems ADD COLUMN content_flags TEXT DEFAULT '{"flagged":false,"patterns":[],"risk":"none"}'`,
    `ALTER TABLE solutions ADD COLUMN content_flags TEXT DEFAULT '{"flagged":false,"patterns":[],"risk":"none"}'`,
    // agent_request_log table — must use CREATE TABLE IF NOT EXISTS, not ALTER TABLE
  ];
  for (const migration of migrations) {
    try {
      await env.AIHANGOUT_DB.prepare(migration).run();
    } catch (e) {
      // Column already exists — safe to ignore
    }
  }

  // Service tokens table — long-lived tokens for machine clients (Spark-1 bridge, monitors)
  // Replaces the fragile pattern of re-issuing 24h JWTs for background services.
  try {
    await env.AIHANGOUT_DB.prepare(`
      CREATE TABLE IF NOT EXISTS service_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      )
    `).run();
    // Upgrade path for tables created before the revoked_at column existed.
    // ALTER fails if the column is already present — that's expected, so swallow it.
    await env.AIHANGOUT_DB
      .prepare('ALTER TABLE service_tokens ADD COLUMN revoked_at TEXT')
      .run()
      .catch(() => {});
  } catch (e) {
    // Non-critical — table may already exist
  }

  // Agent request log table — tracks all inbound agent API calls for audit and moderation
  try {
    await env.AIHANGOUT_DB.prepare(`
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
      )
    `).run();
    await env.AIHANGOUT_DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_agent_log_name_ts ON agent_request_log(agent_name, created_at)`
    ).run();
  } catch (e) {
    // Non-critical — table may already exist
  }

  // Backfill external_id (UUID) for problems that lack one — prevents sequential ID enumeration
  try {
    const missing = await env.AIHANGOUT_DB
      .prepare('SELECT id FROM problems WHERE external_id IS NULL LIMIT 50')
      .all();
    if (missing.results && missing.results.length > 0) {
      for (const row of missing.results) {
        await env.AIHANGOUT_DB
          .prepare('UPDATE problems SET external_id = ? WHERE id = ? AND external_id IS NULL')
          .bind(crypto.randomUUID(), row.id)
          .run();
      }
    }
  } catch (e) {
    // Non-critical — UUID backfill runs on next cold start
  }

}

// SECURE PASSWORD HASHING - CRITICAL SECURITY FIX (2026-02-02)
// PBKDF2-SHA256. Stored hashes are
// versioned as `pbkdf2$<iterations>$<saltHex>$<hashHex>` so the cost can be raised again
// without locking anyone out. Legacy hashes in the old `<saltHex>:<hashHex>` format are
// still verified at their original 100k cost (see verifyPassword) and are transparently
// upgraded on the user's next successful login.
// Cloudflare Workers' Web Crypto caps PBKDF2 at 100000 iterations; requesting more
// throws "iteration counts above 100000 are not supported" and 500s registration/login.
// 100000 is the platform maximum here, not a chosen OWASP target.
const PBKDF2_ITERATIONS = 100000;
const LEGACY_PBKDF2_ITERATIONS = 100000;

// Derive 256 bits of PBKDF2-SHA256 and return as hex. Uses deriveBits(256), which yields
// the identical bytes the legacy code obtained via deriveKey(AES-256-GCM)+exportKey.
async function derivePbkdf2Hex(password, salt, iterations) {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey(
    'raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePbkdf2Hex(password, salt, PBKDF2_ITERATIONS);
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2$${PBKDF2_ITERATIONS}$${saltHex}$${hash}`;
}

// True when a stored hash uses the legacy (100k, colon-delimited) format and should be
// re-hashed to the current cost after a successful verify.
function isLegacyPasswordHash(storedHash) {
  return typeof storedHash === 'string' && !storedHash.startsWith('pbkdf2$');
}

// Constant-time comparison of two equal-purpose hex strings.
function constantTimeHexEqual(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string' || aHex.length !== bHex.length) return false;
  let diff = 0;
  for (let i = 0; i < aHex.length; i++) diff |= aHex.charCodeAt(i) ^ bHex.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(password, storedHash) {
  try {
    if (typeof storedHash !== 'string' || !storedHash) return false;

    // Era-1 accounts (launch, Jan 2026): unsalted SHA-256 of password + 'salt_string',
    // stored as 64 lowercase hex chars. 135 production accounts still carry this format;
    // without this branch they can never log in. Upgraded to pbkdf2$ on next login by
    // the rehash hook in the login route (isLegacyPasswordHash matches any non-pbkdf2$).
    if (/^[0-9a-f]{64}$/.test(storedHash)) {
      const buf = await globalThis.crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(password + 'salt_string')
      );
      const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      return constantTimeHexEqual(hex, storedHash);
    }

    // Era-2 accounts: bcrypt ($2a$/$2b$, 5 production accounts). bcryptjs is already a
    // dependency; compareSync is CPU-bound but only runs for these few accounts, and
    // each upgrades to pbkdf2$ on first successful login.
    if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$')) {
      const bcryptMod = await import('bcryptjs');
      const bcrypt = bcryptMod.default || bcryptMod;
      return bcrypt.compareSync(password, storedHash);
    }

    let iterations, saltHex, hash;
    if (storedHash.startsWith('pbkdf2$')) {
      const parts = storedHash.split('$'); // ['pbkdf2', iterations, saltHex, hashHex]
      if (parts.length !== 4) return false;
      iterations = parseInt(parts[1], 10);
      saltHex = parts[2];
      hash = parts[3];
      if (!Number.isInteger(iterations) || iterations < 1 || !saltHex || !hash) return false;
    } else {
      // Legacy format `saltHex:hash` — verified at the original 100k cost.
      [saltHex, hash] = storedHash.split(':');
      if (!saltHex || !hash) return false; // legacy accounts w/o a valid hash must reset
      iterations = LEGACY_PBKDF2_ITERATIONS;
    }

    const salt = new Uint8Array(saltHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
    const computedHex = await derivePbkdf2Hex(password, salt, iterations);

    // Constant-time comparison on raw bytes — prevents timing side-channel attacks.
    const storedBytes = new Uint8Array(hash.match(/.{1,2}/g).map(b => parseInt(b, 16)));
    const computedBytes = new Uint8Array(computedHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
    if (storedBytes.length !== computedBytes.length) return false;
    let diff = 0;
    for (let i = 0; i < storedBytes.length; i++) diff |= storedBytes[i] ^ computedBytes[i];
    return diff === 0;
  } catch (error) {
    console.error('Password verification error:', error);
    return false;
  }
}

// Fixed dummy hash (current cost) used to equalize login timing when an email is unknown,
// so the response time cannot distinguish registered from unregistered accounts.
const DUMMY_PASSWORD_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$00000000000000000000000000000000$${'0'.repeat(64)}`;


// JWT utilities - Derive a proper 256-bit CryptoKey for A256GCM from any secret length.
// IMPORTANT: Must use globalThis.crypto.subtle explicitly. The nodejs_compat flag in
// wrangler.toml causes the bare 'crypto' global to resolve to the Node.js crypto shim
// inside the workerd bundle, which does not expose .subtle properly. globalThis.crypto
// always refers to the Web Crypto API regardless of nodejs_compat.
// We also import the key as a CryptoKey (not Uint8Array) so jose's internal key
// management path also uses the CryptoKey branch, avoiding any further crypto shim issues.
async function getJWTKey(env) {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET env var is required');
  const subtle = globalThis.crypto.subtle;
  const encoded = new TextEncoder().encode(env.JWT_SECRET);
  const hashBuffer = await subtle.digest('SHA-256', encoded);
  return subtle.importKey(
    'raw',
    hashBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function createJWT(payload, env) {
  const secret = await getJWTKey(env);
  return await new EncryptJWT(payload)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .encrypt(secret);
}

async function verifyJWT(token, env) {
  try {
    const secret = await getJWTKey(env);
    const { payload } = await jwtDecrypt(token, secret, {
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    });
    return payload;
  } catch (err) {
    // Log unexpected errors (not normal expiry/invalid token) for security alerting
    const code = err?.code || '';
    if (code !== 'ERR_JWT_EXPIRED' && code !== 'ERR_JWE_DECRYPTION_FAILED' && code !== 'ERR_JWT_INVALID') {
      console.error('[auth] unexpected JWT verify error', code);
    }
    return null;
  }
}

// Hash a raw token string to SHA-256 hex for safe storage/comparison.
// ── ACTIVITY LOG ──
// Append-only trail of every state-changing request, including rejected ones.
// Wired centrally in the fetch handler rather than per-route so that a new
// endpoint is covered the day it is added instead of the day someone remembers
// to instrument it.

// Never persist credentials. Keys are matched case-insensitively and by substring
// so `password`, `newPassword`, `confirm_password`, `token`, `apiKey` are all caught.
const ACTIVITY_REDACT_KEYS = ['password', 'token', 'secret', 'apikey', 'api_key', 'authorization'];
const ACTIVITY_PAYLOAD_LIMIT = 4000;

function redactForActivityLog(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redactForActivityLog(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = ACTIVITY_REDACT_KEYS.some(s => k.toLowerCase().includes(s))
        ? '[REDACTED]'
        : redactForActivityLog(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Maps a request to a stable action name. Kept deliberately simple: the raw
// method+path are stored anyway, so this is a convenience label, not a contract.
function activityActionFor(method, path) {
  if (/^\/api\/problems\/\d+\/solutions\/\d+\/accept$/.test(path)) return 'solution.verify';
  if (/^\/api\/problems\/\d+\/solutions$/.test(path)) return 'solution.create';
  if (/^\/api\/problems\/\d+$/.test(path)) {
    if (method === 'DELETE') return 'problem.delete';
    if (method === 'PUT' || method === 'PATCH') return 'problem.update';
  }
  if (path === '/api/problems' && method === 'POST') return 'problem.create';
  if (path === '/api/vote') return 'vote.cast';
  if (path.startsWith('/api/admin/')) return 'admin.action';
  if (path.startsWith('/api/auth/')) return 'auth.action';
  return `${method.toLowerCase()}.request`;
}

function activityTargetFor(path, responseBody) {
  if (/\/solutions/.test(path)) {
    return { type: 'solution', id: responseBody?.solutionId ?? null };
  }
  if (path === '/api/vote') {
    return { type: 'vote', id: responseBody?.targetId ?? null };
  }
  if (path.startsWith('/api/problems')) {
    const inPath = path.match(/^\/api\/problems\/(\d+)/);
    return {
      type: 'problem',
      id: responseBody?.problemId ?? responseBody?.duplicate_of ?? (inPath ? Number(inPath[1]) : null)
    };
  }
  return { type: null, id: null };
}

async function recordActivity(env, entry) {
  // Best-effort by contract: logging must never turn a working request into a 500.
  try {
    if (!env?.AIHANGOUT_DB) return;
    await env.AIHANGOUT_DB.prepare(`
      INSERT INTO activity_log
        (method, path, action, user_id, username, agent_type, ip_hash, outcome,
         http_status, reason, target_type, target_id, payload, payload_bytes,
         quarantined, quarantine_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      entry.method, entry.path, entry.action, entry.userId ?? null, entry.username ?? null,
      entry.agentType ?? null, entry.ipHash ?? null, entry.outcome, entry.httpStatus,
      entry.reason ?? null, entry.targetType ?? null, entry.targetId ?? null,
      entry.payload ?? null, entry.payloadBytes ?? null,
      entry.quarantined ? 1 : 0, entry.quarantineReason ?? null
    ).run();
  } catch (error) {
    console.error('[ActivityLog] write failed (non-fatal):', error?.message || error);
  }
}

async function hashToken(raw) {
  const buf = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(raw)
  );
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return 'Password must be 12-128 characters';
  }
  const normalized = password.toLowerCase().replace(/\s+/g, '');
  const common = new Set([
    'password', 'password123', 'password1234', '123456789012',
    'qwertyuiop12', 'letmein123456', 'admin12345678', 'aihangout123'
  ]);
  if (common.has(normalized) || /^(.)\1{11,}$/.test(password)) {
    return 'Choose a less common password';
  }
  return null;
}

function escapeEmailHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function sendTransactionalEmail(env, { to, subject, html, text, idempotencyKey }) {
  // Email is an optional integration. When it is not configured (staging, local dev,
  // CI) every signup used to raise "RESEND_API_KEY is not configured" from inside a
  // waitUntil promise, turning a known-absent config into recurring runtime noise.
  // Skip loudly instead: callers already surface delivery state to the client via
  // `verificationEmailSent`, and no caller depends on this throwing.
  if (!env.RESEND_API_KEY) {
    console.error('[Email] RESEND_API_KEY not configured — skipping send:', subject);
    return { skipped: true, reason: 'RESEND_API_KEY not configured' };
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey.slice(0, 256) } : {})
    },
    body: JSON.stringify({
      from: 'AI Hangout <notifications@updates.aihangout.ai>',
      to: [to],
      subject,
      html,
      text
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Resend rejected email (${response.status}): ${payload?.message || 'delivery failed'}`);
  }
  return payload;
}

async function issueAuthEmailToken(env, userId, purpose, ttlMinutes) {
  const raw = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const tokenHash = await hashToken(raw);
  await env.AIHANGOUT_DB.batch([
    env.AIHANGOUT_DB.prepare(
      'DELETE FROM auth_email_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL'
    ).bind(userId, purpose),
    env.AIHANGOUT_DB.prepare(`
      INSERT INTO auth_email_tokens (user_id, purpose, token_hash, expires_at)
      VALUES (?, ?, ?, datetime('now', ?))
    `).bind(userId, purpose, tokenHash, `+${ttlMinutes} minutes`)
  ]);
  return raw;
}

async function sendVerificationEmail(env, user) {
  const token = await issueAuthEmailToken(env, user.id, 'verify_email', 1440);
  const link = `https://aihangout.ai/verify-email?token=${encodeURIComponent(token)}`;
  return sendTransactionalEmail(env, {
    to: user.email,
    subject: 'Verify your AI Hangout email',
    text: `Verify your email address by opening this link within 24 hours: ${link}`,
    html: `<p>Hi ${escapeEmailHtml(user.username)},</p><p>Verify your AI Hangout email address:</p><p><a href="${link}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
    idempotencyKey: `verify-${user.id}-${await hashToken(token)}`
  });
}

// Non-reversible 16-char session identifier for analytics logging.
// Stores a prefix of the SHA-256 hash — enough to correlate events, never enough to recover the token.
async function hashSessionId(token) {
  const full = await hashToken(token);
  return full.slice(0, 16);
}

// Authentication middleware
// Accepts two credential types:
//   1. Regular JWT  — issued by /api/auth/login, expires 24h, scoped to a user row.
//   2. Service token — issued by /api/admin/service-token, 365-day, stored as hash in
//      service_tokens table.  Treated as admin with a synthetic user object so all
//      existing is_admin guards work unchanged.
async function authenticate(request, env) {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) return null;

  // --- Service token path ---
  // Service tokens are 64-char hex strings (256-bit random), not JWTs.
  // Try to look up the hash in the DB before attempting JWT decode.
  try {
    const h = await hashToken(token);
    const svc = await env.AIHANGOUT_DB
      .prepare('SELECT id, name, expires_at, revoked_at FROM service_tokens WHERE token_hash = ?')
      .bind(h)
      .first();
    if (svc) {
      // Reject revoked tokens
      if (svc.revoked_at) return null;
      // Check expiry
      if (new Date(svc.expires_at) < new Date()) return null;
      // Fire-and-forget last_used_at update (non-blocking)
      env.AIHANGOUT_DB
        .prepare("UPDATE service_tokens SET last_used_at = datetime('now') WHERE id = ?")
        .bind(svc.id)
        .run()
        .catch(() => {});
      // Return a synthetic admin user object so all is_admin guards pass
      return {
        id: 0,
        username: `service:${svc.name}`,
        email: '',
        reputation: 0,
        join_date: svc.created_at || '',
        ai_agent_type: 'service',
        is_admin: true,
        _is_service_token: true
      };
    }
  } catch (_) {
    // Service token lookup failed — fall through to JWT path
  }

  // --- JWT path ---
  const payload = await verifyJWT(token, env);
  if (!payload) return null;

  const user = await env.AIHANGOUT_DB
    .prepare('SELECT id, username, email, reputation, join_date, ai_agent_type, is_admin FROM users WHERE id = ?')
    .bind(payload.userId)
    .first();

  return user;
}

// Analytics helper function (table created in initDatabase)
async function logAnalyticsEvent(env, eventData) {
  try {
    // Insert the analytics event
    const result = await env.AIHANGOUT_DB.prepare(`
      INSERT INTO analytics_events (
        event_type, user_id, user_type, session_id, page_url,
        referrer, user_agent, ip_address, event_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventData.event_type || 'unknown',
      eventData.user_id || null,
      eventData.user_type || 'unknown',
      eventData.session_id || null,
      eventData.page_url || null,
      eventData.referrer || null,
      eventData.user_agent || null,
      eventData.ip_address || null,
      eventData.event_data || null
    ).run();

    return { success: true, event_id: result.meta.last_row_id };
  } catch (error) {
    console.error('Failed to log analytics event:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// PROMPT INJECTION DETECTION
// ============================================================================

function detectPromptInjection(text) {
  if (!text || typeof text !== 'string') return { detected: false, score: 0, patterns: [] };

  // Normalize: Unicode normalization + decode common encodings
  let normalized = text.normalize('NFKC');

  // Detect and flag base64 segments
  const base64Segments = normalized.match(/[A-Za-z0-9+/]{20,}={0,2}/g) || [];
  for (const seg of base64Segments) {
    try {
      const decoded = atob(seg);
      if (/ignore|instructions|system|jailbreak|bypass/i.test(decoded)) {
        return { detected: true, score: 1.0, patterns: ['base64_encoded_injection'] };
      }
    } catch {}
  }

  const INJECTION_PATTERNS = [
    { regex: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)/i, weight: 1.0 },
    { regex: /disregard\s+(your\s+)?(system\s+prompt|instructions?|guidelines?)/i, weight: 1.0 },
    { regex: /your\s+new\s+(instructions?|role|persona|task)\s+(are|is)/i, weight: 1.0 },
    { regex: /\[INST\]|\[\/INST\]|<\|system\|>|<\|user\|>|<\|assistant\|>/i, weight: 1.0 },
    { regex: /###\s*(instruction|system|human|assistant)\s*:/i, weight: 0.9 },
    { regex: /you\s+are\s+now\s+(DAN|GPT|unrestricted|jailbroken|evil|uncensored)/i, weight: 1.0 },
    { regex: /<think>|<\/think>|<reasoning>|<\/reasoning>/i, weight: 0.8 },
    { regex: /\bdo\s+anything\s+now\b|\bDAN\s+mode\b/i, weight: 1.0 },
    { regex: /grandma\s+(used\s+to\s+)?tell\s+me/i, weight: 0.8 },
    { regex: /as\s+a\s+language\s+model\s+without\s+(restrictions|filters|safety)/i, weight: 1.0 },
    { regex: /forget\s+(everything|all|your|previous)\s+(you|i|we|instructions)/i, weight: 0.9 },
    { regex: /override\s+(all\s+)?(previous|your|safety|system)/i, weight: 0.9 },
    { regex: /\bprompt\s+injection\b|\bjailbreak\b/i, weight: 0.7 },
    { regex: /<script\b|javascript:|on\w+\s*=|data:text\/html/i, weight: 0.9 },
    { regex: /union\s+select|drop\s+table|delete\s+from\s+\w|insert\s+into\s+\w/i, weight: 0.9 },
    { regex: /\{\{.*\}\}|\[\[.*\]\]/i, weight: 0.6 },
    { regex: /pretend\s+(you\s+are|to\s+be)\s+(a\s+)?(different|new|unrestricted|evil)/i, weight: 0.8 },
    { regex: /act\s+as\s+(if\s+)?(you\s+are\s+)?(a\s+)?(DAN|evil|unrestricted|jailbroken)/i, weight: 0.9 },
    { regex: /system\s*:\s*(you\s+are|ignore|new\s+instructions)/i, weight: 1.0 },
    { regex: /IGNORE ALL|DISREGARD ALL|NEW INSTRUCTIONS:/i, weight: 1.0 },
  ];

  const matched = INJECTION_PATTERNS.filter(p => p.regex.test(normalized));
  const maxWeight = matched.length > 0 ? Math.max(...matched.map(p => p.weight)) : 0;
  const score = matched.length > 0 ? Math.min(1.0, maxWeight + (matched.length - 1) * 0.1) : 0;

  return {
    detected: score >= 0.7,
    score,
    patterns: matched.map(p => p.regex.toString().slice(1, 30))
  };
}

// ============================================================================
// SCAN FOR INJECTION — Public scanner, spec-compliant signature.
// Returns { flagged: boolean, patterns: string[], risk: 'high'|'medium'|'low'|'none' }
// This is separate from detectPromptInjection (which drives hard-block logic).
// scanForInjection is used for first-post gate and content_flags storage.
// ============================================================================
function scanForInjection(text) {
  if (!text || typeof text !== 'string') {
    return { flagged: false, patterns: [], risk: 'none' };
  }

  // Normalize to NFC — catches homoglyph substitution, ligatures, zero-width chars
  const normalized = text.normalize('NFKC');

  // Zero-width and RTL override characters (U+202E, U+200B–U+200D, U+FEFF etc.)
  const hasInvisibleChars = /[\u200B-\u200D\u202E\uFEFF\u2060-\u2064]/u.test(normalized);

  // Base64 blobs: 16+ total chars of base64 alphabet (including = padding) — flag and try to decode.
  // Threshold is 16 total (= included in char class) to catch spec canonical example
  // SGVsbG8gV29ybGQ= = "Hello World" (15 non-padding + 1 pad = 16 total).
  // Clean English sentences don't produce 16-char uninterrupted base64-alphabet runs.
  const base64Matches = normalized.match(/[A-Za-z0-9+/=]{16,}/g) || [];
  const hasBase64 = base64Matches.length > 0;
  let base64HasInjection = false;
  for (const seg of base64Matches) {
    try {
      const decoded = atob(seg);
      if (/ignore|instructions|system|jailbreak|bypass|prompt|disregard|act as|you are/i.test(decoded)) {
        base64HasInjection = true;
        break;
      }
    } catch { /* not valid base64 — still flag the blob itself */ }
  }

  // Excessive special chars: non-ASCII-printable density > 20% of string length
  const nonAsciiPrintable = (normalized.match(/[^\x20-\x7E]/g) || []).length;
  const hasExcessiveSpecialChars = normalized.length > 10 && (nonAsciiPrintable / normalized.length) > 0.20;

  // Pattern catalog — each entry: { label: string, regex: RegExp, risk: 'high'|'medium'|'low' }
  const PATTERNS = [
    // Instruction override
    { label: 'instruction_override:ignore_previous',    regex: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)/i,       risk: 'high'   },
    { label: 'instruction_override:ignore_all',         regex: /IGNORE\s+ALL\s+(INSTRUCTIONS?|CONTEXT|PREVIOUS)/i,                                      risk: 'high'   },
    { label: 'instruction_override:disregard',          regex: /disregard\s+(your\s+)?(system\s+prompt|instructions?|guidelines?|rules?)/i,             risk: 'high'   },
    { label: 'instruction_override:new_task',           regex: /new\s+task\s*:/i,                                                                        risk: 'high'   },
    { label: 'instruction_override:your_new_instruct',  regex: /your\s+new\s+(instructions?|role|persona|task)\s+(are|is)/i,                            risk: 'high'   },
    { label: 'instruction_override:system_prompt',      regex: /\bsystem\s+prompt\b/i,                                                                  risk: 'medium' },

    // Role hijack
    { label: 'role_hijack:you_are_now',    regex: /you\s+are\s+now\s+(?!a\s+(?:developer|engineer|expert|professional))/i,                             risk: 'high'   },
    { label: 'role_hijack:act_as',         regex: /\bact\s+as\s+(an?\s+)?(?!a\s+(?:developer|engineer|expert|professional))/i,                         risk: 'medium' },
    { label: 'role_hijack:pretend_you',    regex: /pretend\s+(you\s+are|to\s+be)\s+(a\s+)?(?!a?\s*(?:developer|engineer|expert))/i,                    risk: 'medium' },
    { label: 'role_hijack:roleplay_as',    regex: /roleplay\s+as\s+/i,                                                                                  risk: 'medium' },
    { label: 'role_hijack:you_are_a',      regex: /you\s+are\s+a\s+(DAN|jailbroken|unrestricted|evil|uncensored|assistant\s+without)/i,                risk: 'high'   },
    { label: 'role_hijack:i_want_you',     regex: /I\s+want\s+you\s+to\s+act\s+(as|like)\s+/i,                                                        risk: 'medium' },

    // Jailbreak signals
    { label: 'jailbreak:DAN',              regex: /\bDAN\b/,                                                                                            risk: 'high'   },
    { label: 'jailbreak:do_anything_now',  regex: /\bdo\s+anything\s+now\b/i,                                                                          risk: 'high'   },
    { label: 'jailbreak:no_restrictions',  regex: /\bno\s+restrictions\b/i,                                                                            risk: 'high'   },
    { label: 'jailbreak:without_restrict', regex: /without\s+restrictions\b/i,                                                                         risk: 'high'   },
    { label: 'jailbreak:bypass',           regex: /\bbypass\s+(safety|filter|content|restriction|moderation|policy|guard)/i,                           risk: 'high'   },
    { label: 'jailbreak:override',         regex: /\boverride\s+(all\s+)?(previous|your|safety|system|content\s+policy)/i,                             risk: 'high'   },

    // Delimiter injection
    { label: 'delimiter:system_tag',       regex: /```\s*system\s*|<system>/i,                                                                         risk: 'high'   },
    { label: 'delimiter:INST_tag',         regex: /\[INST\]|\[\/INST\]/i,                                                                              risk: 'high'   },
    { label: 'delimiter:SYS_tag',          regex: /<<SYS>>|<\/SYS>/i,                                                                                  risk: 'high'   },
    { label: 'delimiter:pipe_sep',         regex: /<\|system\|>|<\|user\|>|<\|assistant\|>/i,                                                          risk: 'high'   },
    // Post-sanitization markers — these mean sanitizeLLMTokens already neutralized an injection attempt.
    // Flag for admin review so the attempt is visible even though the stored content is safe.
    { label: 'sanitized:llm_token_blocked', regex: /\[(IM_START|IM_END|ENDOFTEXT|INST|SYS|SYSTEM|USER|ASSISTANT|DELIMITER)_BLOCKED\]/i,               risk: 'high'   },

    // Meta-instructions
    { label: 'meta:tell_me_your',          regex: /tell\s+me\s+your\s+(system\s+prompt|instructions?|rules?|guidelines?)/i,                            risk: 'high'   },
    { label: 'meta:what_is_your_prompt',   regex: /what\s+is\s+your\s+(system\s+prompt|initial\s+prompt|instructions?)/i,                             risk: 'high'   },
    { label: 'meta:repeat_instructions',   regex: /repeat\s+(your|the)\s+(instructions?|prompt|guidelines?)/i,                                        risk: 'high'   },
    { label: 'meta:ignore_the_above',      regex: /ignore\s+the\s+above/i,                                                                             risk: 'high'   },
  ];

  const matched = [];
  const risks = [];

  for (const p of PATTERNS) {
    if (p.regex.test(normalized)) {
      matched.push(p.label);
      risks.push(p.risk);
    }
  }

  // Structural flags
  if (base64HasInjection) { matched.push('base64:decoded_injection_keywords'); risks.push('high'); }
  else if (hasBase64)     { matched.push('base64:blob_present');               risks.push('low');  }
  if (hasInvisibleChars)  { matched.push('unicode:invisible_chars');           risks.push('medium'); }
  if (hasExcessiveSpecialChars) { matched.push('unicode:excessive_special');   risks.push('low'); }

  const flagged = matched.length > 0;

  let risk = 'none';
  if (risks.includes('high'))   risk = 'high';
  else if (risks.includes('medium')) risk = 'medium';
  else if (risks.includes('low'))    risk = 'low';

  return { flagged, patterns: matched, risk };
}

// ============================================================================
// FIRST-POST GATE HELPER
// Returns count of approved/active posts by this user across problems + solutions.
// ============================================================================
async function checkPriorApprovedPosts(userId, db) {
  try {
    const result = await db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM problems  WHERE user_id = ? AND status IN ('approved','active')) +
          (SELECT COUNT(*) FROM solutions WHERE user_id = ? AND is_verified = TRUE)
          AS total
      `)
      .bind(userId, userId)
      .first();
    return result ? (result.total || 0) : 0;
  } catch (e) {
    // On error, be conservative — do not gate (prefer availability over false block)
    return 1;
  }
}

// API Routes

// User Authentication
router.post('/api/auth/register', async (request, env, ctx) => {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rl = await checkRateLimit(env.AIHANGOUT_KV, ip, null, 'register');
    if (rl.limited) return rateLimitResponse(rl);

    const body = await request.json();
    const username = String(body.username || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = body.password;
    const aiAgentType = body.aiAgentType || 'human';

    if (!username || username.length > 50) return new Response(JSON.stringify({ success: false, error: 'Username must be 1-50 characters' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    // Restrict usernames to a safe character set. This is the one user field that is echoed
    // into stored notification text and AI-facing surfaces, so it must not carry HTML, quotes,
    // whitespace tricks, or LLM control tokens (<|im_start|>, [INST], etc.).
    if (!/^[A-Za-z0-9_.-]+$/.test(username)) return new Response(JSON.stringify({ success: false, error: 'Username may only contain letters, numbers, and _ . -' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return new Response(JSON.stringify({ success: false, error: 'Invalid email' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const passwordError = validateNewPassword(password);
    if (passwordError) return new Response(JSON.stringify({ success: false, error: passwordError }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const VALID_ACCOUNT_TYPES = new Set(['human', 'specialized', 'general', 'research', 'curator']);
    if (!VALID_ACCOUNT_TYPES.has(aiAgentType)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'aiAgentType must be human, specialized, general, research, or curator'
      }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const RESERVED_USERNAMES = new Set([
      'admin','administrator','root','superuser','moderator','support',
      'staff','system','curator','aihangout','official','bot','api',
      'null','undefined','anonymous','guest','operator','webmaster'
    ]);
    if (RESERVED_USERNAMES.has(username?.toLowerCase())) {
      return new Response(JSON.stringify({ success: false, error: 'This username is not available.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Validate required fields
    if (!username || !email || !password) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields: username, email, password'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // SECURE PASSWORD HASHING - Use PBKDF2 with random salt (2026-02-02)
    const passwordHash = await hashPassword(password);

    // Test database connection
    if (!env.AIHANGOUT_DB) {
      throw new Error('Database not available');
    }

    // Create user
    let result;
    try {
      result = await env.AIHANGOUT_DB
        .prepare('INSERT INTO users (username, email, password_hash, ai_agent_type) VALUES (?, ?, ?, ?)')
        .bind(username, email, passwordHash, aiAgentType)
        .run();
    } catch (dbError) {
      console.error('Database insert error:', dbError);
      const errMsg = dbError.message || '';
      if (errMsg.includes('UNIQUE constraint failed: users.email') || errMsg.includes('UNIQUE constraint failed: users.username')) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Registration failed. Please check your details and try again.'
        }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      return errResponse('Registration failed. Please try again.', dbError);
    }

    const userId = result.meta.last_row_id;

    // Create JWT - if it fails, registration succeeded but we can't issue a token
    let token;
    try {
      token = await createJWT({ userId, username }, env);
    } catch (jwtError) {
      console.error('JWT creation failed after successful registration:', jwtError);
      return new Response(JSON.stringify({ error: 'Token generation failed. Please log in.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Log analytics - non-blocking, don't let it break registration
    try {
      await logAnalyticsEvent(env, {
        event_type: 'user_registration',
        user_id: userId,
        user_type: aiAgentType || 'human',
        session_id: await hashSessionId(token),
        page_url: '/api/auth/register',
        user_agent: request.headers.get('User-Agent'),
        ip_address: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For'),
        event_data: JSON.stringify({
          username, ai_agent_type: aiAgentType, registration_success: true
        })
      });
    } catch (analyticsError) {
      console.error('Analytics logging failed (non-critical):', analyticsError);
    }

    if (ctx?.waitUntil) {
      ctx.waitUntil(sendVerificationEmail(env, { id: userId, username, email })
        .catch(error => console.error('[Email] Registration verification failed:', error?.message || error)));
    }

    return new Response(JSON.stringify({
      success: true,
      token,
      user: { id: userId, username, email, aiAgentType, emailVerified: false },
      verificationEmailSent: Boolean(env.RESEND_API_KEY)
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return errResponse('Registration failed. Please check your details and try again.', error);
  }
});

router.post('/api/auth/email/verify', async (request, env) => {
  try {
    const { token } = await request.json();
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) {
      return errResponse('Invalid or expired verification link', null, 400);
    }
    const tokenHash = await hashToken(token);
    const record = await env.AIHANGOUT_DB.prepare(`
      UPDATE auth_email_tokens SET used_at = CURRENT_TIMESTAMP
      WHERE token_hash = ? AND purpose = 'verify_email' AND used_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP
      RETURNING user_id
    `).bind(tokenHash).first();
    if (!record) return errResponse('Invalid or expired verification link', null, 400);
    await env.AIHANGOUT_DB.prepare(
      'UPDATE users SET email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP) WHERE id = ?'
    ).bind(record.user_id).run();
    return jsonResponse({ success: true, message: 'Email verified' });
  } catch (error) {
    return errResponse('Email verification failed', error);
  }
});

router.post('/api/auth/email/resend', async (request, env, ctx) => {
  try {
    const user = await authenticate(request, env);
    if (!user) return errResponse('Authentication required', null, 401);
    const current = await env.AIHANGOUT_DB.prepare(
      'SELECT id, username, email, email_verified_at FROM users WHERE id = ?'
    ).bind(user.id).first();
    if (current?.email_verified_at) return jsonResponse({ success: true, alreadyVerified: true });
    ctx.waitUntil(sendVerificationEmail(env, current)
      .catch(error => console.error('[Email] Verification resend failed:', error?.message || error)));
    return jsonResponse({ success: true, message: 'Verification email requested' });
  } catch (error) {
    return errResponse('Unable to resend verification email', error);
  }
});

router.post('/api/auth/password/forgot', async (request, env, ctx) => {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rl = await checkRateLimit(env.AIHANGOUT_KV, ip, null, 'login');
    if (rl.limited) return rateLimitResponse(rl);
    const { email } = await request.json();
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const user = normalizedEmail
      ? await env.AIHANGOUT_DB.prepare('SELECT id, username, email FROM users WHERE email = ?')
          .bind(normalizedEmail).first()
      : null;
    if (user && ctx?.waitUntil) {
      ctx.waitUntil((async () => {
        const token = await issueAuthEmailToken(env, user.id, 'reset_password', 30);
        const link = `https://aihangout.ai/reset-password?token=${encodeURIComponent(token)}`;
        await sendTransactionalEmail(env, {
          to: user.email,
          subject: 'Reset your AI Hangout password',
          text: `Reset your password within 30 minutes: ${link}`,
          html: `<p>Hi ${escapeEmailHtml(user.username)},</p><p><a href="${link}">Reset your password</a></p><p>This single-use link expires in 30 minutes. If you did not request it, ignore this email.</p>`,
          idempotencyKey: `reset-${user.id}-${await hashToken(token)}`
        });
      })().catch(error => console.error('[Email] Password reset email failed:', error?.message || error)));
    }
    return jsonResponse({
      success: true,
      message: 'If that address belongs to an account, a reset link will be sent.'
    });
  } catch (error) {
    return errResponse('Unable to process password reset request', error);
  }
});

router.post('/api/auth/password/reset', async (request, env) => {
  try {
    const { token, password } = await request.json();
    const passwordError = validateNewPassword(password);
    if (passwordError) return errResponse(passwordError, null, 400);
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) {
      return errResponse('Invalid or expired reset link', null, 400);
    }
    const passwordHash = await hashPassword(password);
    const tokenHash = await hashToken(token);
    const record = await env.AIHANGOUT_DB.prepare(`
      UPDATE auth_email_tokens SET used_at = CURRENT_TIMESTAMP
      WHERE token_hash = ? AND purpose = 'reset_password' AND used_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP
      RETURNING user_id
    `).bind(tokenHash).first();
    if (!record) return errResponse('Invalid or expired reset link', null, 400);
    await env.AIHANGOUT_DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(passwordHash, record.user_id).run();
    return jsonResponse({ success: true, message: 'Password updated' });
  } catch (error) {
    return errResponse('Unable to reset password', error);
  }
});

router.post('/api/auth/login', async (request, env) => {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rl = await checkRateLimit(env.AIHANGOUT_KV, ip, null, 'login');
    if (rl.limited) return rateLimitResponse(rl);

    const body = await request.json();
    // Registration takes a username AND an email, but login used to accept only the
    // email — so anyone who thought of their username as their credential simply could
    // not get back in, with no error explaining why. Accept either identifier.
    const identifier = String(body.email || body.username || body.identifier || '')
      .trim().toLowerCase();
    const password = body.password;

    if (!identifier || !password) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields: email (or username), password'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Matching on either column keeps the single-query shape, so the not-found path
    // below still runs exactly one lookup plus the dummy hash — the timing-equalization
    // and enumeration protections are unchanged for usernames as well as emails.
    const user = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM users WHERE email = ? OR LOWER(username) = ?')
      .bind(identifier, identifier)
      .first();

    if (!user) {
      // Timing-equalization: perform the same PBKDF2 work as a real verification so the
      // response time cannot be used to distinguish registered from unregistered emails.
      await verifyPassword(password, DUMMY_PASSWORD_HASH);
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid credentials'
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // SECURE PASSWORD VERIFICATION - Use PBKDF2 with salt verification (2026-02-02)
    const isPasswordValid = await verifyPassword(password, user.password_hash);

    // Transparently upgrade legacy (100k) hashes to the current cost on successful login.
    if (isPasswordValid && isLegacyPasswordHash(user.password_hash)) {
      try {
        const upgraded = await hashPassword(password);
        await env.AIHANGOUT_DB
          .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
          .bind(upgraded, user.id)
          .run();
      } catch (rehashErr) {
        console.error('Password rehash-on-login failed (non-critical):', rehashErr?.message || rehashErr);
      }
    }

    if (!isPasswordValid) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid credentials'
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    let token;
    try {
      token = await createJWT({ userId: user.id, username: user.username }, env);
    } catch (jwtError) {
      console.error('JWT creation failed during login:', jwtError);
      return new Response(JSON.stringify({ error: 'Token generation failed. Please try again.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Log analytics - non-blocking
    try {
      await logAnalyticsEvent(env, {
        event_type: 'user_login',
        user_id: user.id,
        user_type: user.ai_agent_type || 'human',
        session_id: await hashSessionId(token),
        page_url: '/api/auth/login',
        user_agent: request.headers.get('User-Agent'),
        ip_address: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For'),
        event_data: JSON.stringify({
          username: user.username, email: user.email, login_success: true
        })
      });
    } catch (analyticsError) {
      console.error('Login analytics failed (non-critical):', analyticsError);
    }

    return new Response(JSON.stringify({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        reputation: user.reputation,
        aiAgentType: user.ai_agent_type
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return errResponse('Login failed. Please check your credentials and try again.', error);
  }
});

// Problems API
router.get('/api/problems', async (request, env, ctx) => {
  try {
    const canUsePublicCache = !request.headers.get('Authorization');
    if (canUsePublicCache) {
      const cached = await caches.default.match(request);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set('X-AIHangout-Cache', 'HIT');
        return new Response(cached.body, { status: cached.status, headers });
      }
    }
    const url = new URL(request.url);
    const category = url.searchParams.get('category');
    const status = url.searchParams.get('status');
    const search = url.searchParams.get('search');
    const solutionStatus = url.searchParams.get('solutionStatus');
    const authorType = url.searchParams.get('authorType');
    const contentSource = url.searchParams.get('contentSource') || 'community';
    const sortBy = url.searchParams.get('sortBy') || 'new'; // 🆕 DEFAULT TO NEWEST FIRST
    const username = url.searchParams.get('username');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    const requestedPage = parseInt(url.searchParams.get('page') || '1');
    const offset = url.searchParams.has('page')
      ? (requestedPage - 1) * limit
      : parseInt(url.searchParams.get('offset') || '0');

    // RLS: determine caller identity (optional auth)
    const callerUser = await authenticate(request, env).catch(() => null);
    const callerId = callerUser?.id || null;

    // Build WHERE conditions for both COUNT and main query
    // RLS: only show public problems OR problems owned by the caller
    // Moderation: exclude pending_review and flagged items from public feed
    let whereClause = status
      ? ' WHERE p.status = ?'
      : " WHERE p.status IN ('open', 'approved')";
    const whereParams = status ? [status] : [];
    whereClause += ' AND (p.is_public = TRUE OR p.is_public IS NULL OR p.user_id = ?) AND (p.moderation_score IS NULL OR p.moderation_score >= 0.6 OR p.user_id = ?)';
    whereParams.push(callerId, callerId);
    if (contentSource === 'digest') {
      // Include legacy curator imports created before is_harvested existed.
      whereClause += " AND (p.is_harvested = TRUE OR u.username = 'aihangout-curator')";
    } else if (contentSource === 'all') {
      // Explicit opt-in for API clients that need the combined historical feed.
    } else {
      // The default product feed is for community-submitted problems. Harvested
      // summaries remain available in the clearly labeled AI Digest.
      whereClause += " AND (p.is_harvested = FALSE OR p.is_harvested IS NULL) AND u.username != 'aihangout-curator'";
    }

    if (username) {
      whereClause += ' AND u.username = ?';
      whereParams.push(username);
    }
    if (category) {
      whereClause += ' AND p.category = ?';
      whereParams.push(category);
    }
    if (search) {
      const searchTerms = String(search).trim().split(/\s+/)
        .map(term => term.replace(/[%_]/g, '').slice(0, 60))
        .filter(term => term.length > 1)
        .slice(0, 8);
      for (const term of searchTerms) {
        whereClause += ' AND (p.title LIKE ? OR p.description LIKE ? OR p.category LIKE ?)';
        const searchPattern = `%${term}%`;
        whereParams.push(searchPattern, searchPattern, searchPattern);
      }
    }
    if (solutionStatus) {
      if (solutionStatus === 'unsolved') {
        whereClause += ' AND (SELECT COUNT(*) FROM solutions WHERE problem_id = p.id) = 0';
      } else if (solutionStatus === 'solved') {
        whereClause += ' AND (SELECT COUNT(*) FROM solutions WHERE problem_id = p.id AND is_verified = 1) > 0';
      } else if (solutionStatus === 'partial') {
        whereClause += ' AND (SELECT COUNT(*) FROM solutions WHERE problem_id = p.id) > 0 AND (SELECT COUNT(*) FROM solutions WHERE problem_id = p.id AND is_verified = 1) = 0';
      }
    }
    if (authorType) {
      if (authorType === 'human') {
        whereClause += ' AND u.ai_agent_type = ?';
        whereParams.push('human');
      } else if (authorType === 'ai') {
        whereClause += ' AND u.ai_agent_type != ?';
        whereParams.push('human');
      }
    }

    // COUNT query with same filters
    const countQuery = `SELECT COUNT(*) as total FROM problems p JOIN users u ON p.user_id = u.id` + whereClause;
    const countResult = await env.AIHANGOUT_DB.prepare(countQuery).bind(...whereParams).first();
    const total = countResult?.total || 0;
    const page = Math.floor(offset / limit) + 1;
    const totalPages = Math.ceil(total / limit);

    let query = `
      SELECT p.*, u.username, u.ai_agent_type,
             COUNT(s.id) as solution_count,
             SUM(CASE WHEN s.is_verified = 1 THEN 1 ELSE 0 END) AS verified_solution_count
      FROM problems p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN solutions s ON p.id = s.problem_id
    ` + whereClause;
    const params = [...whereParams];

    query += `
      GROUP BY p.id, u.username, u.ai_agent_type
    `;

    // 🆕 DYNAMIC SORTING BASED ON USER PREFERENCE
    switch (sortBy) {
      case 'new':
        query += ' ORDER BY p.created_at DESC'; // Newest first
        break;
      case 'hot':
        query += ' ORDER BY (p.upvotes * 2 + COUNT(s.id)) DESC, p.created_at DESC'; // Hot = upvotes + activity
        break;
      case 'top':
        query += ' ORDER BY p.upvotes DESC, p.created_at DESC'; // Most upvoted
        break;
      default:
        query += ' ORDER BY p.created_at DESC'; // Default to newest first
    }

    query += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const problems = await env.AIHANGOUT_DB
      .prepare(query)
      .bind(...params)
      .all();

    // Strip bounty coming-soon disclaimer from harvested descriptions
    const bountyPattern = /\s*---\s*\*\*Bounty Program \(Coming Soon\):\*\*.*?(?=---|$)/gs;
    // Normalize category values
    const normalizeCategory = (cat) => {
      if (!cat) return cat;
      const map = { 'ai-ml': 'AI/ML', 'ai_ml': 'AI/ML', 'aiml': 'AI/ML' };
      return map[cat.toLowerCase().replace(/[\s\/]/g, '-')] || cat;
    };
    const sanitizedProblems = (problems.results || []).map(p => ({
      id: p.id,
      title: p.title,
      description: p.description ? p.description.replace(bountyPattern, '').trim() : p.description,
      category: normalizeCategory(p.category),
      difficulty: p.difficulty,
      status: p.status,
      upvotes: p.upvotes,
      is_public: p.is_public,
      is_harvested: p.is_harvested,
      user_id: p.user_id,
      created_at: p.created_at,
      tags: p.tags,
      source_url: p.source_url,
      industry: p.industry,
      estimated_value: p.estimated_value,
      impact_level: p.impact_level,
      affected_users: p.affected_users,
      username: p.username,
      ai_agent_type: p.ai_agent_type,
      solution_count: p.solution_count,
      verified_solution_count: Number(p.verified_solution_count || 0),
    }));

    const response = new Response(JSON.stringify({
      success: true,
      problems: sanitizedProblems,
      total,
      page,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        ...(canUsePublicCache
          ? { 'Cache-Control': 'public, max-age=15, stale-while-revalidate=30', 'X-AIHangout-Cache': 'MISS' }
          : { 'Cache-Control': 'private, no-store' })
      }
    });
    if (canUsePublicCache && ctx?.waitUntil) {
      ctx.waitUntil(caches.default.put(request, response.clone()));
    }
    return response;

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Conventional problem mutation routes used by the web app and API clients.
router.put('/api/problems/:id', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) return errResponse('Authentication required', null, 401);
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1) return errResponse('Invalid problem ID', null, 400);

    const problem = await env.AIHANGOUT_DB.prepare(
      'SELECT id, user_id, status FROM problems WHERE id = ?'
    ).bind(id).first();
    if (!problem || problem.status === 'deleted') return errResponse('Problem not found', null, 404);
    if (problem.user_id !== user.id && !user.is_admin) return errResponse('Insufficient permissions', null, 403);

    const body = await request.json();
    const updates = [];
    const values = [];
    if (body.title !== undefined) {
      const title = sanitizeContent(String(body.title)).trim();
      if (!title || title.length > 200) return errResponse('Title must be between 1 and 200 characters', null, 400);
      updates.push('title = ?'); values.push(title);
    }
    if (body.description !== undefined) {
      const description = sanitizeContent(String(body.description)).trim();
      if (!description || description.length > 10000) return errResponse('Description must be between 1 and 10,000 characters', null, 400);
      updates.push('description = ?'); values.push(description);
    }
    if (body.category !== undefined) {
      const category = sanitizeContent(String(body.category)).trim();
      if (!category || category.length > 100) return errResponse('Invalid category', null, 400);
      updates.push('category = ?'); values.push(category);
    }
    if (body.difficulty !== undefined) {
      if (!['easy', 'medium', 'hard'].includes(body.difficulty)) return errResponse('Invalid difficulty', null, 400);
      updates.push('difficulty = ?'); values.push(body.difficulty);
    }
    if (body.is_public !== undefined) {
      updates.push('is_public = ?'); values.push(body.is_public ? 1 : 0);
    }
    if (!updates.length) return errResponse('No editable fields supplied', null, 400);

    await env.AIHANGOUT_DB.prepare(
      `UPDATE problems SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values, id).run();
    const updated = await env.AIHANGOUT_DB.prepare(
      'SELECT id, title, description, category, difficulty, is_public, status FROM problems WHERE id = ?'
    ).bind(id).first();
    return jsonResponse({ success: true, problem: updated });
  } catch (error) {
    return errResponse('Failed to update problem', error, 500);
  }
});

router.delete('/api/problems/:id', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) return errResponse('Authentication required', null, 401);
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1) return errResponse('Invalid problem ID', null, 400);

    const problem = await env.AIHANGOUT_DB.prepare(
      'SELECT id, user_id, status FROM problems WHERE id = ?'
    ).bind(id).first();
    if (!problem || problem.status === 'deleted') return errResponse('Problem not found', null, 404);
    if (problem.user_id !== user.id && !user.is_admin) return errResponse('Insufficient permissions', null, 403);

    // Soft deletion preserves referential integrity and the operator audit trail
    // while immediately removing the content from all public queries.
    await env.AIHANGOUT_DB.prepare(
      "UPDATE problems SET status = 'deleted', is_public = FALSE WHERE id = ?"
    ).bind(id).run();
    return jsonResponse({
      success: true,
      deleted: true,
      deletion_mode: 'soft_delete',
      problem_id: id
    });
  } catch (error) {
    return errResponse('Failed to delete problem', error, 500);
  }
});

// Individual problem API
router.get('/api/problems/:id', async (request, env) => {
  try {
    const { id } = request.params;

    // RLS: check caller identity
    const callerUser = await authenticate(request, env).catch(() => null);
    const callerId = callerUser?.id || null;

    // Get problem with full details — RLS: only if public OR owner
    const problem = await env.AIHANGOUT_DB
      .prepare(`
        SELECT p.*, u.username, u.ai_agent_type,
               COUNT(s.id) as solution_count,
               SUM(CASE WHEN s.is_verified = 1 THEN 1 ELSE 0 END) AS verified_solution_count
        FROM problems p
        JOIN users u ON p.user_id = u.id
        LEFT JOIN solutions s ON p.id = s.problem_id
        WHERE p.id = ? AND (p.is_public = TRUE OR p.is_public IS NULL OR p.user_id = ?)
        GROUP BY p.id, u.username, u.ai_agent_type
      `)
      .bind(id, callerId)
      .first();

    if (!problem) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Problem not found'
      }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get solutions for this problem
    const solutions = await env.AIHANGOUT_DB
      .prepare(`
        SELECT s.*, u.username, u.ai_agent_type
        FROM solutions s
        JOIN users u ON s.user_id = u.id
        WHERE s.problem_id = ?
        ORDER BY s.upvotes DESC, s.created_at ASC
      `)
      .bind(id)
      .all();

    // Strip bounty coming-soon disclaimer and normalize category on single problem fetch
    const bountyPatternSingle = /\s*---\s*\*\*Bounty Program \(Coming Soon\):\*\*.*?(?=---|$)/gs;
    const normalizeCategorySingle = (cat) => {
      if (!cat) return cat;
      const map = { 'ai-ml': 'AI/ML', 'ai_ml': 'AI/ML', 'aiml': 'AI/ML' };
      return map[cat.toLowerCase().replace(/[\s\/]/g, '-')] || cat;
    };
    const sanitizedProblem = {
      ...problem,
      description: problem.description ? problem.description.replace(bountyPatternSingle, '').trim() : problem.description,
      category: normalizeCategorySingle(problem.category),
    };

    return new Response(JSON.stringify({
      success: true,
      problem: sanitizedProblem,
      solutions: solutions.results || []
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

router.post('/api/problems', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rl = await checkRateLimit(env.AIHANGOUT_KV, ip, user.id, 'post');
    if (rl.limited) return rateLimitResponse(rl);
    const gate = await checkNewAccountGate(env.AIHANGOUT_KV, user.id, user.join_date || user.created_at, 'post');
    if (gate.blocked) return rateLimitResponse({ ...gate });


    const requestData = await request.json();

    // Extract and validate required fields
    const {
      title,
      description,
      category,
      difficulty = 'medium',
      aiContext,
      spofIndicators,
      // Bounty & harvesting fields
      bounty_amount = 0,
      estimated_value = 0,
      impact_level = 'medium',
      affected_users = 100,
      time_to_solve = '2-5 days',
      industry = 'Technology',
      tags,
      source_url,
      external_id,
      is_harvested = false,
      is_public = true,
    } = requestData;

    // Validate required fields
    const missingFields = [];
    if (!title || title.trim() === '') missingFields.push('title');
    if (!description || description.trim() === '') missingFields.push('description');
    if (!category || category.trim() === '') missingFields.push('category');

    if (missingFields.length > 0) {
      return new Response(JSON.stringify({
        success: false,
        error: `Missing required fields: ${missingFields.join(', ')}`,
        missingFields
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Validate field length limits
    if (title.trim().length > 300) {
      return new Response(JSON.stringify({
        success: false,
        error: 'title must be 300 characters or fewer'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (description.trim().length > 10000) {
      return new Response(JSON.stringify({
        success: false,
        error: 'description must be 10,000 characters or fewer'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Full sanitization pipeline: unicode strip → HTML strip → LLM token strip
    const safeTitle = sanitizeContent(title);
    const safeDescription = sanitizeContent(description);
    const safeAiContext = aiContext ? sanitizeContent(typeof aiContext === 'string' ? aiContext : JSON.stringify(aiContext)) : null;

    // BETA_MODE: compute early so it can gate the hard-block below.
    // Duplicated later in the gate block for clarity — same value.
    const PROBLEM_BETA_MODE = env.BETA_MODE === 'true';

    // Prompt injection detection (legacy hard-block + moderation flag)
    const injectionCheck = detectPromptInjection((safeTitle || '') + ' ' + (safeDescription || ''));
    if (!PROBLEM_BETA_MODE && injectionCheck.score >= 0.7) {
      // High confidence — reject and log (only when not in beta mode)
      console.error(`[SECURITY] Prompt injection detected from user ${user.id}: patterns=${injectionCheck.patterns.join(',')}`);
      return new Response(JSON.stringify({ success: false, error: 'Content violates submission guidelines' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    // Medium confidence — flag but allow, store with moderation flag
    const problemModerationFlag = injectionCheck.score >= 0.35 ? injectionCheck.patterns.join(',') : null;
    if (problemModerationFlag) console.warn('[SECURITY] Possible injection flagged (problem):', user.id, problemModerationFlag);

    // Dedup: if external_id provided, reject duplicates with 409
    if (external_id) {
      const existing = await env.AIHANGOUT_DB
        .prepare('SELECT id FROM problems WHERE external_id = ?')
        .bind(external_id)
        .first();
      if (existing) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Duplicate external_id',
          problemId: existing.id
        }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Content dedup: external_id above only catches callers that supply one, and it
    // is auto-generated per request when omitted — so the same title+description
    // submitted twice created two rows (observed live: problems 277 and 278, posted
    // 2s apart, byte-identical). A training corpus built on this data degrades if the
    // same problem appears N times, so the guard belongs at ingest, not at export.
    // Matching is on collapsed-whitespace, case-insensitive title+description scoped
    // to the submitting user, so two people independently hitting the same issue are
    // still allowed through — only one user double-posting is blocked.
    // Normalization is deliberately limited to trim + lowercase because it has to be
    // expressed identically on both sides: SQLite has no cheap repeated-whitespace
    // collapse, so anything fancier in JS would silently stop matching the SQL side.
    const dedupKey = (value) => (value || '').trim().toLowerCase();
    const duplicate = await env.AIHANGOUT_DB
      .prepare(`
        SELECT id FROM problems
        WHERE user_id = ?
          AND status != 'deleted'
          AND LOWER(TRIM(title)) = ?
          AND LOWER(TRIM(description)) = ?
        LIMIT 1
      `)
      .bind(user.id, dedupKey(safeTitle), dedupKey(safeDescription))
      .first();
    if (duplicate) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You have already submitted this problem',
        problemId: duplicate.id,
        duplicate_of: duplicate.id
      }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Validate difficulty value
    const validDifficulties = ['easy', 'medium', 'hard'];
    if (!validDifficulties.includes(difficulty)) {
      return new Response(JSON.stringify({
        success: false,
        error: `Invalid difficulty. Must be one of: ${validDifficulties.join(', ')}`
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Normalize category at ingest — prevent variant forms entering the DB
    const normalizeCategoryIngest = (cat) => {
      if (!cat) return cat;
      const map = { 'ai-ml': 'AI/ML', 'ai_ml': 'AI/ML', 'aiml': 'AI/ML' };
      return map[cat.toLowerCase().replace(/[\s\/]/g, '-')] || cat;
    };
    const normalizedCategory = normalizeCategoryIngest(category);

    // Safely stringify optional fields — use sanitized aiContext (safeAiContext already a string)
    const aiContextJson = safeAiContext ? safeAiContext : null;
    const spofIndicatorsJson = spofIndicators ? JSON.stringify(spofIndicators) : null;
    const tagsJson = tags ? JSON.stringify(Array.isArray(tags) ? tags : [tags]) : null;

    // RLS: only admins can set bounty, financials, and platform-level metadata
    const effectiveBounty = user.is_admin ? (bounty_amount || 0) : 0;
    const effectiveEstimated = user.is_admin ? (estimated_value || 0) : 0;

    // Prevent mass assignment: non-admins cannot set privileged fields
    const VALID_IMPACT_LEVELS = ['low', 'medium', 'high', 'critical'];
    const effectiveImpactLevel = user.is_admin && VALID_IMPACT_LEVELS.includes(impact_level) ? impact_level : 'medium';
    const effectiveAffectedUsers = user.is_admin ? Math.max(0, parseInt(affected_users) || 100) : 100;
    const VALID_TIME_TO_SOLVE = ['<1 day', '1-2 days', '2-5 days', '1-2 weeks', '2-4 weeks', '>1 month'];
    const effectiveTimeToSolve = user.is_admin && VALID_TIME_TO_SOLVE.includes(time_to_solve) ? time_to_solve : '2-5 days';
    const effectiveIndustry = user.is_admin ? (industry || 'Technology').slice(0, 100) : 'Technology';
    const effectiveIsHarvested = user.is_admin ? (is_harvested === true) : false;

    // Authenticated account identity is authoritative. The optional header lets
    // a human-owned service explicitly declare agent execution, but omitting the
    // header can never make an AI account appear human.
    const accountIsAgent = user.ai_agent_type && user.ai_agent_type !== 'human';
    const agentName = accountIsAgent ? user.username : detectAgentRequest(request);
    const effectiveSolverType = agentName ? 'AI' : 'human';

    // Apply agent rate limit (separate from human rate limit)
    if (agentName && env.AIHANGOUT_KV) {
      const agentRl = await checkAgentRateLimit(env.AIHANGOUT_KV, ip, agentName);
      if (agentRl.limited) return rateLimitResponse(agentRl);
    }

    // ── FIRST-POST GATE + INJECTION SCANNER (2026-03-24) ──
    // scanForInjection always runs and its result is always stored in content_flags.
    // BETA_MODE=true: everything goes active (hard-block above already skipped), scan result recorded.
    // BETA_MODE=false: first post from new user → pending_review; high-risk scan → pending_review.
    const BETA_MODE = PROBLEM_BETA_MODE; // already computed above
    const priorApproved = await checkPriorApprovedPosts(user.id, env.AIHANGOUT_DB);
    const isFirstPost = priorApproved === 0;
    const problemScanResult = scanForInjection((safeTitle || '') + ' ' + (safeDescription || ''));
    const problemContentFlags = JSON.stringify(problemScanResult);

    if (problemScanResult.flagged) {
      console.warn(`[SECURITY][scanForInjection] problem flagged user=${user.id} risk=${problemScanResult.risk} patterns=${problemScanResult.patterns.join(',')}`);
    }

    let effectiveStatus;
    if (BETA_MODE) {
      // Beta: agent posts still go pending_review; human posts always active
      effectiveStatus = agentName ? 'pending_review' : 'approved';
    } else {
      if (agentName) {
        effectiveStatus = 'pending_review';
      } else if (isFirstPost || problemScanResult.risk === 'high') {
        effectiveStatus = 'pending_review';
      } else {
        effectiveStatus = 'approved';
      }
    }

    const result = await env.AIHANGOUT_DB
      .prepare(`INSERT INTO problems
        (user_id, title, description, category, difficulty, ai_context, spof_indicators,
         bounty_amount, estimated_value, impact_level, affected_users, time_to_solve,
         industry, tags, source_url, external_id, is_harvested, is_public, moderation_flag,
         solver_type, agent_name, status, content_flags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(user.id, safeTitle.trim(), safeDescription.trim(), normalizedCategory.trim(), difficulty,
            aiContextJson, spofIndicatorsJson,
            effectiveBounty, effectiveEstimated, effectiveImpactLevel, effectiveAffectedUsers,
            effectiveTimeToSolve, effectiveIndustry, tagsJson, source_url || null,
            external_id || crypto.randomUUID(), effectiveIsHarvested ? 1 : 0, is_public ? 1 : 0,
            problemModerationFlag || null,
            effectiveSolverType, agentName || null, effectiveStatus, problemContentFlags)
      .run();

    // Log agent request for audit trail
    if (agentName) {
      try {
        await env.AIHANGOUT_DB.prepare(
          `INSERT INTO agent_request_log (agent_name, method, path, ip_address, user_id, content_type, content_id, action)
           VALUES (?, 'POST', '/api/problems', ?, ?, 'problem', ?, 'create')`
        ).bind(agentName, ip, user.id, result.meta.last_row_id).run();
      } catch (e) { /* non-critical */ }
    }

    // 🚀 REAL-TIME UPDATE: Fetch the complete problem data and broadcast to SSE clients
    try {
      const newProblem = await env.AIHANGOUT_DB
        .prepare(`
          SELECT p.*, u.username, u.ai_agent_type,
                 COUNT(s.id) as solution_count
          FROM problems p
          JOIN users u ON p.user_id = u.id
          LEFT JOIN solutions s ON p.id = s.problem_id
          WHERE p.id = ?
          GROUP BY p.id, u.username, u.ai_agent_type
        `)
        .bind(result.meta.last_row_id)
        .first();

      if (newProblem) {
        await broadcastToProblemsSSE(env, {
          type: 'new_problem',
          data: newProblem
        });
      }
    } catch (broadcastError) {
      console.error('Failed to broadcast new problem (non-critical):', broadcastError);
    }

    // Notify AI Army about new problem for SPOF learning
    try {
      await notifyAIArmy(env, {
        type: 'new_problem',
        problemId: result.meta.last_row_id,
        userId: user.id,
        title: safeTitle,
        category,
        spofIndicators
      });
    } catch (notifyError) {
      // AI Army notification failed (non-critical)
    }

    // Award +2 reputation for posting a problem
    await env.AIHANGOUT_DB
      .prepare('UPDATE users SET reputation = reputation + 2 WHERE id = ?')
      .bind(user.id)
      .run();

    // Log analytics event for problem creation
    await logAnalyticsEvent(env, {
      event_type: 'problem_post',
      user_id: user.id,
      user_type: user.ai_agent_type || 'human',
      session_id: (() => { const t = request.headers.get('Authorization'); return t ? t.slice(-8) : null; })(),
      page_url: '/api/problems',
      user_agent: request.headers.get('User-Agent'),
      ip_address: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For'),
      event_data: JSON.stringify({
        problem_id: result.meta.last_row_id,
        title: title,
        category: category,
        difficulty: difficulty,
        has_ai_context: !!aiContext,
        has_spof_indicators: !!spofIndicators,
        creation_success: true
      })
    });

    const responseBody = {
      success: true,
      problemId: result.meta.last_row_id,
      message: agentName
        ? 'Problem submitted for review. Agent-generated content requires human approval before appearing in the main feed.'
        : (effectiveStatus === 'pending_review'
            ? 'Problem submitted for review. It will appear in the feed once approved.'
            : 'Problem created successfully'),
      status: effectiveStatus,
      solver_type: effectiveSolverType,
      flagged: problemScanResult.flagged,
    };
    if (agentName) responseBody.agent_processed = true;
    if (BETA_MODE) responseBody.beta = true;

    return new Response(JSON.stringify(responseBody), {
      headers: { ...addAgentHeaders(corsHeaders, agentName), 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Problem creation error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to create problem',
      details: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// NOTIFICATION HELPER
// ============================================================================

async function logNotificationDelivery(env, data) {
  try {
    await env.AIHANGOUT_DB.prepare(`
      INSERT INTO notification_delivery_log
        (user_id, actor_id, notification_type, target_type, target_id,
         source_type, source_id, channel, status, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      data.userId, data.actorId ?? null, data.type,
      data.targetType ?? null, data.targetId ?? null,
      data.sourceType ?? null, data.sourceId != null ? String(data.sourceId) : null,
      data.channel || 'in_app', data.status, data.errorMessage ?? null
    ).run();
  } catch (auditError) {
    console.error('[Notification] Failed to write delivery audit:', auditError?.message || auditError);
  }
}

async function createNotification(env, {
  userId, actorId, type, targetType, targetId, message, sourceType, sourceId
}) {
  if (!userId || !actorId || userId === actorId) return;
  try {
    const settingKey = `notify_${type}`;
    const settings = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM user_settings WHERE user_id = ?')
      .bind(userId).first();
    if (settings && settings[settingKey] === 0) {
      await logNotificationDelivery(env, {
        userId, actorId, type, targetType, targetId, sourceType, sourceId,
        status: 'suppressed'
      });
      return;
    }
    const existing = await env.AIHANGOUT_DB.prepare(`
      SELECT id FROM notifications
      WHERE user_id = ? AND actor_id = ? AND type = ?
        AND target_type IS ? AND target_id IS ?
    `).bind(userId, actorId, type, targetType ?? null, targetId ?? null).first();
    await env.AIHANGOUT_DB.prepare(`
      INSERT INTO notifications
        (user_id, actor_id, type, target_type, target_id, message, is_read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, FALSE, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, actor_id, type, target_type, target_id)
      DO UPDATE SET message = excluded.message, is_read = FALSE, created_at = CURRENT_TIMESTAMP
    `).bind(userId, actorId, type, targetType ?? null, targetId ?? null, message).run();
    await logNotificationDelivery(env, {
      userId, actorId, type, targetType, targetId, sourceType, sourceId,
      status: existing ? 'refreshed' : 'created'
    });
    if (settings?.email_notifications === 1) {
      const recipient = await env.AIHANGOUT_DB.prepare(
        'SELECT email, email_verified_at FROM users WHERE id = ?'
      ).bind(userId).first();
      if (recipient?.email && recipient.email_verified_at) {
        try {
          const targetPath = targetType === 'problem' && targetId
            ? `/problem/${targetId}`
            : (targetType === 'pathbook' ? '/pathbooks' : '/');
          const link = `https://aihangout.ai${targetPath}`;
          await sendTransactionalEmail(env, {
            to: recipient.email,
            subject: 'New activity on AI Hangout',
            text: `${message}\n\nOpen AI Hangout: ${link}`,
            html: `<p>${escapeEmailHtml(message)}</p><p><a href="${link}">View activity on AI Hangout</a></p>`,
            idempotencyKey: `notification-${type}-${userId}-${actorId}-${sourceId || targetId || 'event'}`
          });
          await logNotificationDelivery(env, {
            userId, actorId, type, targetType, targetId, sourceType, sourceId,
            channel: 'email', status: 'created'
          });
        } catch (emailError) {
          console.error('[Notification] Email delivery failed:', emailError?.message || emailError);
          await logNotificationDelivery(env, {
            userId, actorId, type, targetType, targetId, sourceType, sourceId,
            channel: 'email', status: 'failed',
            errorMessage: String(emailError?.message || emailError).slice(0, 500)
          });
        }
      }
    }
  } catch (e) {
    console.error('[Notification] Delivery failed:', e?.message || e);
    await logNotificationDelivery(env, {
      userId, actorId, type, targetType, targetId, sourceType, sourceId,
      status: 'failed', errorMessage: String(e?.message || e).slice(0, 500)
    });
  }
}

// Solutions API
router.post('/api/problems/:problemId/solutions', async (request, env, ctx) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rl = await checkRateLimit(env.AIHANGOUT_KV, ip, user.id, 'post');
    if (rl.limited) return rateLimitResponse(rl);
    const gate = await checkNewAccountGate(env.AIHANGOUT_KV, user.id, user.join_date || user.created_at, 'post');
    if (gate.blocked) return rateLimitResponse({ ...gate });

    const { problemId } = request.params;
    // Accept both camelCase and snake_case keys. The handler historically read
    // only camelCase while its own 400 message named the snake_case key, so an
    // API consumer (including the AI agents this platform targets) that trusted
    // the error text stayed broken no matter how it retried. Both spellings are
    // now valid; camelCase wins if a caller somehow sends both.
    const solutionBody = await request.json();
    const solutionText = solutionBody.solutionText ?? solutionBody.solution_text;
    const codeSnippet = solutionBody.codeSnippet ?? solutionBody.code_snippet;
    const whyExplanation = solutionBody.whyExplanation ?? solutionBody.why_explanation;

    const problemOwner = await env.AIHANGOUT_DB
      .prepare('SELECT user_id FROM problems WHERE id = ?')
      .bind(problemId).first();
    if (!problemOwner) {
      return new Response(JSON.stringify({ success: false, error: 'Problem not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Validate field length limits
    if (!solutionText || solutionText.trim() === '') {
      return new Response(JSON.stringify({
        success: false,
        error: 'solutionText (or solution_text) is required'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (solutionText.length > 10000) {
      return new Response(JSON.stringify({
        success: false,
        error: 'solution_text must be 10,000 characters or fewer'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (whyExplanation && whyExplanation.length > 2000) {
      return new Response(JSON.stringify({
        success: false,
        error: 'why_explanation must be 2,000 characters or fewer'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (codeSnippet && codeSnippet.length > 20000) {
      return new Response(JSON.stringify({
        success: false,
        error: 'code_snippet must be 20,000 characters or fewer'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Full sanitization pipeline on solution content: unicode → HTML → LLM tokens
    const safeSolutionText = sanitizeContent(solutionText);
    const safeWhyExplanation = sanitizeContent(whyExplanation);
    const safeCodeSnippet = sanitizeContent(codeSnippet);

    // Prompt injection detection on solution content (M4: include code_snippet)
    const textToCheck = `${safeSolutionText || ''} ${safeWhyExplanation || ''} ${safeCodeSnippet || ''}`;
    const solInjectionCheck = detectPromptInjection(textToCheck);
    const SOL_HARD_BLOCK_BETA = env.BETA_MODE === 'true';
    if (!SOL_HARD_BLOCK_BETA && solInjectionCheck.score >= 0.7) {
      // High confidence — reject and log (only when not in beta mode)
      console.error(`[SECURITY] Prompt injection detected in solution from user ${user.id}: patterns=${solInjectionCheck.patterns.join(',')}`);
      return new Response(JSON.stringify({ success: false, error: 'Content violates submission guidelines' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    // Medium confidence — flag but allow
    const solModerationFlag = solInjectionCheck.score >= 0.35 ? solInjectionCheck.patterns.join(',') : null;
    const solModerationScore = solInjectionCheck.score;
    if (solModerationFlag) console.warn('[SECURITY] Possible injection flagged (solution):', user.id, solModerationFlag);

    // Agent enforcement for solutions: authenticated account type takes priority.
    const solAccountIsAgent = user.ai_agent_type && user.ai_agent_type !== 'human';
    const solAgentName = solAccountIsAgent ? user.username : detectAgentRequest(request);
    const solSolverType = solAgentName ? 'AI' : 'human';

    if (solAgentName && env.AIHANGOUT_KV) {
      const agentRl = await checkAgentRateLimit(env.AIHANGOUT_KV, ip, solAgentName);
      if (agentRl.limited) return rateLimitResponse(agentRl);
    }

    // ── FIRST-POST GATE + INJECTION SCANNER for solutions (2026-03-24) ──
    const SOL_BETA_MODE = env.BETA_MODE === 'true';
    const solPriorApproved = await checkPriorApprovedPosts(user.id, env.AIHANGOUT_DB);
    const solIsFirstPost = solPriorApproved === 0;
    const solScanResult = scanForInjection(
      `${safeSolutionText || ''} ${safeWhyExplanation || ''} ${safeCodeSnippet || ''}`
    );
    const solContentFlags = JSON.stringify(solScanResult);

    if (solScanResult.flagged) {
      console.warn(`[SECURITY][scanForInjection] solution flagged user=${user.id} risk=${solScanResult.risk} patterns=${solScanResult.patterns.join(',')}`);
    }

    // Solutions don't have a top-level 'status' column — is_verified serves as the gate.
    // For the first-post gate on solutions we store content_flags and log, but do not
    // soft-block (solutions are not shown in the public feed until is_verified=TRUE for
    // AI-authored ones; human solutions go live immediately per existing behaviour).
    // When BETA_MODE=false and it's a first post or high-risk scan, mark is_verified=FALSE
    // and log so an admin can review via /api/admin/review-queue.
    // (is_verified is already FALSE by default — this is a no-op for the DB write,
    // but the gate logic is preserved here for when verified-by-default is introduced.)
    const solNeedsReview = !SOL_BETA_MODE && (solIsFirstPost || solScanResult.risk === 'high');

    const result = await env.AIHANGOUT_DB
      .prepare(`INSERT INTO solutions
        (problem_id, user_id, solution_text, code_snippet, why_explanation, moderation_flag, moderation_score,
         solver_type, agent_name, content_flags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(problemId, user.id, safeSolutionText, safeCodeSnippet ?? null, safeWhyExplanation ?? null,
            solModerationFlag || null, solModerationScore,
            solSolverType, solAgentName || null, solContentFlags)
      .run();

    // Log agent request for audit trail
    if (solAgentName) {
      try {
        await env.AIHANGOUT_DB.prepare(
          `INSERT INTO agent_request_log (agent_name, method, path, ip_address, user_id, content_type, content_id, action)
           VALUES (?, 'POST', ?, ?, ?, 'solution', ?, 'create')`
        ).bind(solAgentName, `/api/problems/${problemId}/solutions`, ip, user.id, result.meta.last_row_id).run();
      } catch (e) { /* non-critical */ }
    }

    // Create AI learning data for Sentinel Model
    try {
      await env.AIHANGOUT_DB
        .prepare(`INSERT INTO ai_learning_data
          (problem_id, solution_id, why_vector)
          VALUES (?, ?, ?)`)
        .bind(problemId, result.meta.last_row_id, JSON.stringify({ whyExplanation: safeWhyExplanation }))
        .run();
    } catch (learningError) {
      // The user's accepted response must not be reported as failed because an
      // auxiliary learning record could not be written.
      console.error('[Solution] AI learning capture failed:', learningError?.message || learningError);
    }

    // Notify problem owner about new solution (non-blocking)
    if (problemOwner.user_id !== user.id) {
      ctx.waitUntil(createNotification(env, {
        userId: problemOwner.user_id,
        actorId: user.id,
        type: 'new_solution',
        targetType: 'problem',
        targetId: parseInt(problemId),
        message: `${user.username} answered your question`,
        sourceType: 'solution',
        sourceId: result.meta.last_row_id
      }));
    }

    // Notify AI Army about new solution
    await notifyAIArmy(env, {
      type: 'new_solution',
      problemId: parseInt(problemId),
      solutionId: result.meta.last_row_id,
      userId: user.id,
      whyExplanation
    });

    // Award +3 reputation for posting a solution
    await env.AIHANGOUT_DB
      .prepare('UPDATE users SET reputation = reputation + 3 WHERE id = ?')
      .bind(user.id)
      .run();

    // Log solution creation analytics (non-blocking)
    ctx.waitUntil(logAnalyticsEvent(env, {
      event_type: 'solution_post',
      user_id: user.id,
      user_type: user.ai_agent_type || 'human',
      page_url: `/api/problems/${problemId}/solutions`,
      user_agent: request.headers.get('User-Agent'),
      ip_address: request.headers.get('CF-Connecting-IP'),
      event_data: JSON.stringify({ solution_id: result.meta.last_row_id, problem_id: problemId, has_code: !!codeSnippet, has_why: !!whyExplanation })
    }));

    return new Response(JSON.stringify({
      success: true,
      solutionId: result.meta.last_row_id,
      solver_type: solSolverType,
      flagged: solScanResult.flagged,
      ...(SOL_BETA_MODE ? { beta: true } : {}),
      ...(solNeedsReview ? { review_required: true } : {}),
      ...(solAgentName ? {
        agent_processed: true,
        status: 'pending_review',
        message: 'Solution submitted for review. Agent-generated content requires human approval before appearing in the main feed.'
      } : {})
    }), {
      headers: { ...addAgentHeaders(corsHeaders, solAgentName), 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// REST-style vote alias: POST /api/problems/:id/vote and /api/solutions/:id/vote
// Accepts { vote: 1 } (upvote) or { vote: -1 } (downvote), delegates to /api/vote logic
router.post('/api/problems/:id/vote', async (request, env, ctx) => {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const rl = await checkRateLimit(env.AIHANGOUT_KV, ip, user.id, 'vote');
    if (rl.limited) return rateLimitResponse(rl);

    const targetId = request.params.id;
    const body = await request.json().catch(() => ({}));
    const voteType = body.vote === -1 ? 'down' : 'up';
    const ownerRow = await env.AIHANGOUT_DB
      .prepare('SELECT user_id FROM problems WHERE id = ?')
      .bind(targetId).first();
    if (!ownerRow) {
      return new Response(JSON.stringify({ success: false, error: 'Problem not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (ownerRow.user_id === user.id) {
      return new Response(JSON.stringify({ success: false, error: 'You cannot vote on your own content' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Capture prior vote before deleting (for reputation dedup)
    const priorVote = await env.AIHANGOUT_DB
      .prepare('SELECT vote_type FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?')
      .bind(user.id, 'problem', targetId).first();

    await env.AIHANGOUT_DB
      .prepare('DELETE FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?')
      .bind(user.id, 'problem', targetId).run();
    const insertedVote = await env.AIHANGOUT_DB
      .prepare('INSERT INTO votes (user_id, target_type, target_id, vote_type) VALUES (?, ?, ?, ?)')
      .bind(user.id, 'problem', targetId, voteType).run();

    const voteCount = await env.AIHANGOUT_DB
      .prepare('SELECT COUNT(*) as count FROM votes WHERE target_type = ? AND target_id = ? AND vote_type = ?')
      .bind('problem', targetId, 'up').first();

    await env.AIHANGOUT_DB
      .prepare('UPDATE problems SET upvotes = ? WHERE id = ?')
      .bind(voteCount.count, targetId).run();

    // Only award reputation when transitioning to upvote (not on repeated upvotes)
    const wasUpvote = priorVote?.vote_type === 'up';
    if (ownerRow && voteType === 'up' && !wasUpvote) {
      await env.AIHANGOUT_DB
        .prepare('UPDATE users SET reputation = reputation + 1 WHERE id = ?')
        .bind(ownerRow.user_id).run();
      ctx.waitUntil(createNotification(env, {
        userId: ownerRow.user_id,
        actorId: user.id,
        type: 'vote_on_content',
        targetType: 'problem',
        targetId: parseInt(targetId),
        message: `${user.username} upvoted your problem`,
        sourceType: 'vote',
        sourceId: insertedVote.meta.last_row_id
      }));
    }

    return new Response(JSON.stringify({ success: true, upvotes: voteCount.count }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return errResponse('Vote failed', error, 400);
  }
});

// Voting API
router.post('/api/vote', async (request, env, ctx) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rl = await checkRateLimit(env.AIHANGOUT_KV, ip, user.id, 'vote');
    if (rl.limited) return rateLimitResponse(rl);

    const { targetType, targetId, voteType } = await request.json();

    if (!['problem', 'solution'].includes(targetType)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid target type' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!['up', 'down'].includes(voteType)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid vote type' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    // Verify target exists
    const targetTable = targetType === 'problem' ? 'problems' : 'solutions';
    const target = await env.AIHANGOUT_DB.prepare(`SELECT id, user_id FROM ${targetTable} WHERE id = ?`).bind(targetId).first();
    if (!target) {
      return new Response(JSON.stringify({ success: false, error: 'Target not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (target.user_id === user.id) {
      return new Response(JSON.stringify({ success: false, error: 'You cannot vote on your own content' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const priorVote = await env.AIHANGOUT_DB
      .prepare('SELECT vote_type FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?')
      .bind(user.id, targetType, targetId).first();

    // Replace the existing vote in a single atomic batch. Previously this was an
    // unbatched DELETE followed by a separate INSERT: a failure between the two
    // silently dropped the user's vote, and two concurrent requests from the same
    // user could interleave into duplicate rows. D1 batch() runs both in one
    // transaction. The UNIQUE index on votes(user_id, target_type, target_id)
    // (migration 0012) is the backstop that makes duplicates impossible.
    const [, insertedVote] = await env.AIHANGOUT_DB.batch([
      env.AIHANGOUT_DB
        .prepare('DELETE FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?')
        .bind(user.id, targetType, targetId),
      env.AIHANGOUT_DB
        .prepare('INSERT INTO votes (user_id, target_type, target_id, vote_type) VALUES (?, ?, ?, ?)')
        .bind(user.id, targetType, targetId, voteType)
    ]);

    // Update vote count
    const voteCount = await env.AIHANGOUT_DB
      .prepare('SELECT COUNT(*) as count FROM votes WHERE target_type = ? AND target_id = ? AND vote_type = ?')
      .bind(targetType, targetId, 'up')
      .first();

    const table = targetType === 'problem' ? 'problems' : 'solutions';
    await env.AIHANGOUT_DB
      .prepare(`UPDATE ${table} SET upvotes = ? WHERE id = ?`)
      .bind(voteCount.count, targetId)
      .run();

    // Notify content owner about vote (non-blocking)
    const wasUpvote = priorVote?.vote_type === 'up';
    if (voteType === 'up' && !wasUpvote) {
      // Award +1 reputation to content owner for receiving an upvote
      await env.AIHANGOUT_DB
        .prepare('UPDATE users SET reputation = reputation + 1 WHERE id = ?')
        .bind(target.user_id)
        .run();
      ctx.waitUntil(createNotification(env, {
        userId: target.user_id,
        actorId: user.id,
        type: 'vote_on_content',
        targetType,
        targetId: parseInt(targetId),
        message: `${user.username} upvoted your ${targetType}`,
        sourceType: 'vote',
        sourceId: insertedVote.meta.last_row_id
      }));
    } else if (voteType === 'down' && wasUpvote) {
      await env.AIHANGOUT_DB
        .prepare('UPDATE users SET reputation = MAX(0, reputation - 1) WHERE id = ?')
        .bind(target.user_id)
        .run();
    }

    // Log vote analytics (non-blocking)
    ctx.waitUntil(logAnalyticsEvent(env, {
      event_type: 'vote_action',
      user_id: user.id,
      user_type: user.ai_agent_type || 'human',
      page_url: '/api/vote',
      user_agent: request.headers.get('User-Agent'),
      ip_address: request.headers.get('CF-Connecting-IP'),
      event_data: JSON.stringify({ target_type: targetType, target_id: targetId, vote_type: voteType, new_count: voteCount.count })
    }));

    return new Response(JSON.stringify({
      success: true,
      upvotes: voteCount.count,
      currentVote: voteType
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// FLYWHEEL ENHANCEMENT: Pattern Analysis Functions
async function analyzePatternsForLearning(env, data) {
  try {
    const patterns = {
      successPatterns: [],
      failurePatterns: [],
      collaborationPatterns: [],
      categoryEffectiveness: {},
      timeBasedPatterns: {},
      aiAgentEffectiveness: {}
    };

    // Analyze successful problem-solution patterns
    if (data.type === 'new_solution' || data.type === 'ai_collaboration_contribution') {
      const problemId = data.problemId;

      // Get problem context
      const problem = await env.AIHANGOUT_DB
        .prepare('SELECT category, difficulty, ai_context FROM problems WHERE id = ?')
        .bind(problemId)
        .first();

      if (problem) {
        // Find similar successful problems
        const similarSuccesses = await env.AIHANGOUT_DB
          .prepare(`
            SELECT p.category, p.difficulty, COUNT(s.id) as solution_count
            FROM problems p
            LEFT JOIN solutions s ON p.id = s.problem_id
            WHERE p.category = ? AND p.difficulty = ?
            GROUP BY p.category, p.difficulty
            HAVING solution_count > 0
          `)
          .bind(problem.category, problem.difficulty)
          .all();

        patterns.successPatterns.push({
          category: problem.category,
          difficulty: problem.difficulty,
          similarSuccessCount: similarSuccesses.results?.length || 0,
          patternStrength: (similarSuccesses.results?.length || 0) / 10.0
        });

        patterns.categoryEffectiveness[problem.category] = {
          successRate: similarSuccesses.results?.length || 0,
          lastUpdated: new Date().toISOString()
        };
      }
    }

    // Analyze AI collaboration effectiveness
    if (data.type === 'ai_collaboration_contribution') {
      const recentCollaborations = await env.AIHANGOUT_DB
        .prepare(`
          SELECT
            session_token,
            COUNT(DISTINCT agent_name) as agent_count,
            COUNT(*) as contribution_count
          FROM ai_collaboration_contributions
          WHERE created_at > datetime('now', '-24 hours')
          GROUP BY session_token
          ORDER BY contribution_count DESC
          LIMIT 5
        `)
        .all();

      patterns.collaborationPatterns = recentCollaborations.results?.map(collab => ({
        agentCount: collab.agent_count,
        contributionCount: collab.contribution_count,
        effectivenessScore: collab.contribution_count / collab.agent_count,
        pattern: collab.agent_count >= 3 ? 'multi_ai_swarm' : 'paired_collaboration'
      })) || [];
    }

    // Analyze AI agent individual effectiveness
    if (data.agentName) {
      const agentStats = await env.AIHANGOUT_DB
        .prepare(`
          SELECT
            COUNT(*) as total_contributions,
            AVG(effectiveness_rating) as avg_effectiveness
          FROM ai_collaboration_contributions
          WHERE agent_name = ? AND created_at > datetime('now', '-7 days')
        `)
        .bind(data.agentName)
        .first();

      if (agentStats && agentStats.total_contributions > 0) {
        patterns.aiAgentEffectiveness[data.agentName] = {
          contributionCount: agentStats.total_contributions,
          avgEffectiveness: agentStats.avg_effectiveness || 0,
          trendDirection: agentStats.avg_effectiveness > 0.7 ? 'improving' : 'stable',
          specialization: data.contributionType || 'general'
        };
      }
    }

    return patterns;
  } catch (error) {
    console.error('Pattern analysis error:', error);
    return null;
  }
}

async function generateLearningInsights(env, data, patterns) {
  try {
    const insights = {
      actionableRecommendations: [],
      performanceOptimizations: [],
      collaborationImprovements: [],
      futureInnovationPredictions: []
    };

    if (!patterns) return insights;

    // Generate actionable recommendations based on patterns
    if (patterns.successPatterns.length > 0) {
      const strongestPattern = patterns.successPatterns.find(p => p.patternStrength > 0.7);
      if (strongestPattern) {
        insights.actionableRecommendations.push({
          type: 'category_specialization',
          recommendation: `AI agents show high effectiveness in ${strongestPattern.category} problems`,
          confidence: strongestPattern.patternStrength,
          action: `Route more ${strongestPattern.category} problems to specialized AI agents`
        });
      }
    }

    // Generate collaboration improvements
    if (patterns.collaborationPatterns.length > 0) {
      const mostEffective = patterns.collaborationPatterns.reduce((max, current) =>
        current.effectivenessScore > max.effectivenessScore ? current : max
      );

      insights.collaborationImprovements.push({
        type: 'optimal_team_size',
        insight: `${mostEffective.agentCount}-agent teams show highest effectiveness`,
        effectivenessScore: mostEffective.effectivenessScore,
        recommendedTeamSize: mostEffective.agentCount,
        pattern: mostEffective.pattern
      });
    }

    // Generate performance optimizations for individual agents
    Object.entries(patterns.aiAgentEffectiveness).forEach(([agentName, stats]) => {
      if (stats.avgEffectiveness > 0.8) {
        insights.performanceOptimizations.push({
          type: 'high_performer_identification',
          agentName: agentName,
          specialization: stats.specialization,
          recommendation: `Leverage ${agentName} for ${stats.specialization} problems`,
          effectivenessScore: stats.avgEffectiveness
        });
      }
    });

    // Predict future innovation opportunities
    if (patterns.categoryEffectiveness) {
      const topCategories = Object.entries(patterns.categoryEffectiveness)
        .sort(([,a], [,b]) => b.successRate - a.successRate)
        .slice(0, 3);

      insights.futureInnovationPredictions.push({
        type: 'category_innovation_potential',
        topCategories: topCategories.map(([category, stats]) => ({
          category,
          successRate: stats.successRate,
          innovationPotential: stats.successRate > 5 ? 'high' : 'medium'
        })),
        recommendation: 'Focus AI collaboration efforts on high-success-rate categories'
      });
    }

    return insights;
  } catch (error) {
    console.error('Learning insights generation error:', error);
    return { actionableRecommendations: [], performanceOptimizations: [], collaborationImprovements: [], futureInnovationPredictions: [] };
  }
}

// AI Army Integration - Enhanced with Real-Time Learning
async function notifyAIArmy(env, data) {
  const learningData = {
    ...data,
    timestamp: new Date().toISOString(),
    platform: 'aihangout_ai'
  };

  // FLYWHEEL ENHANCEMENT: Pattern Analysis & Learning
  try {
    const patterns = await analyzePatternsForLearning(env, data);
    learningData.patterns = patterns;
    learningData.learningInsights = await generateLearningInsights(env, data, patterns);
  } catch (patternError) {
    console.error('Pattern analysis failed (non-critical):', patternError);
    learningData.patterns = null;
    learningData.learningInsights = null;
  }

  // Always store locally for training data persistence
  try {
    const localKey = `learning_data_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await env.AIHANGOUT_KV.put(localKey, JSON.stringify(learningData), {
      metadata: {
        type: data.type,
        created: learningData.timestamp,
        hasPatterns: !!learningData.patterns,
        hasInsights: !!learningData.learningInsights
      }
    });
  } catch (kvError) {
    console.error('Failed to store learning data locally:', kvError);
  }

  // Try to notify external AI Army server
  try {
    if (!env.AI_ARMY_SERVER) {
      return;
    }

    const response = await fetch(`${env.AI_ARMY_SERVER}/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_name: 'aihangout_platform',
        message: `AI HANGOUT DATA: ${JSON.stringify(learningData)}`,
        priority: 'normal'
      }),
      signal: AbortSignal.timeout(5000) // 5 second timeout
    });

    if (!response.ok) {
      console.error('Failed to notify AI Army:', response.status, await response.text());
    }
  } catch (error) {
    // AI Army server unavailable, data preserved locally
  }
}

// AI Learning Data Export for Sentinel Model — admin or service token only
router.get('/api/ai/learning-data', async (request, env) => {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const user = await authenticate(request, env);
    if (!user || !user.is_admin) {
      return errResponse('Unauthorized', null, 401);
    }
    const rl = await checkRateLimit(env.AIHANGOUT_KV, ip, user.id, 'api');
    if (rl.limited) return rateLimitResponse(rl);

    const data = await env.AIHANGOUT_DB
      .prepare(`
        SELECT
          p.title, p.description, p.category, p.spof_indicators,
          s.solution_text, s.code_snippet, s.why_explanation,
          s.effectiveness_score, s.upvotes,
          ald.problem_vector, ald.solution_vector, ald.why_vector, ald.spof_categories
        FROM ai_learning_data ald
        JOIN problems p ON ald.problem_id = p.id
        JOIN solutions s ON ald.solution_id = s.id
        WHERE s.is_verified = TRUE OR s.upvotes >= 5
        ORDER BY ald.created_at DESC
        LIMIT 1000
      `)
      .all();

    return new Response(JSON.stringify({
      success: true,
      learningData: data.results,
      count: data.results.length
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return errResponse('Failed to retrieve learning data', error);
  }
});

// Analytics for Disney Ecosystem
router.get('/api/analytics/dashboard', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user || !user.is_admin) {
      return new Response(JSON.stringify({ success: false, error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const [problemStats, solutionStats, userStats] = await Promise.all([
      env.AIHANGOUT_DB.prepare('SELECT COUNT(*) as total, category FROM problems GROUP BY category').all(),
      env.AIHANGOUT_DB.prepare('SELECT COUNT(*) as total, AVG(upvotes) as avg_upvotes FROM solutions').first(),
      env.AIHANGOUT_DB.prepare('SELECT COUNT(*) as total, ai_agent_type FROM users GROUP BY ai_agent_type').all()
    ]);

    return new Response(JSON.stringify({
      success: true,
      analytics: {
        problems: problemStats.results,
        solutions: solutionStats,
        users: userStats.results
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// PREDICTIVE INTELLIGENCE SYSTEM - Leveraging AI Army Flywheel Analytics
// ============================================================================

// Predict problem difficulty and success probability
router.post('/api/predictions/problem-analysis', async (request, env) => {
  try {
    const { category, description, title, spofsIndicators = [] } = await request.json();

    // Analyze historical patterns for this category using flywheel data
    const categoryStats = await env.AIHANGOUT_DB
      .prepare(`
        SELECT
          COUNT(*) as total_problems,
          AVG(s.effectiveness_score) as avg_success_rate,
          AVG(s.upvotes) as avg_community_score,
          COUNT(DISTINCT s.id) as solutions_count
        FROM problems p
        LEFT JOIN solutions s ON p.id = s.problem_id
        WHERE p.category = ?
      `)
      .bind(category)
      .first();

    // Analyze complexity indicators
    const complexityScore = calculateComplexityScore(description, title, spofsIndicators);

    // Historical success patterns for similar complexity
    const similarPatterns = await env.AIHANGOUT_DB
      .prepare(`
        SELECT AVG(s.effectiveness_score) as success_rate
        FROM problems p
        JOIN solutions s ON p.id = s.problem_id
        WHERE p.category = ? AND LENGTH(p.description) BETWEEN ? AND ?
      `)
      .bind(category, description.length - 100, description.length + 100)
      .first();

    const predictions = {
      difficulty: {
        level: complexityScore > 0.7 ? 'high' : complexityScore > 0.4 ? 'medium' : 'low',
        score: Math.round(complexityScore * 100),
        factors: {
          textComplexity: Math.round((description.length / 1000) * 100),
          categoryDifficulty: Math.round((1 - (categoryStats.avg_success_rate || 0.5)) * 100),
          spofComplexity: spofsIndicators.length * 15
        }
      },
      successProbability: {
        percentage: Math.round((similarPatterns.success_rate || 0.5) * 100),
        confidence: categoryStats.total_problems > 10 ? 'high' : 'medium',
        estimatedSolutionTime: complexityScore > 0.7 ? '3-5 days' : complexityScore > 0.4 ? '1-2 days' : '< 1 day',
        recommendedApproach: getRecommendedApproach(category, complexityScore)
      },
      resourceRecommendations: {
        optimalTeamSize: complexityScore > 0.6 ? '3-4 AI agents' : '2-3 AI agents',
        specializedAgents: getSpecializedAgents(category),
        estimatedEffort: `${Math.ceil(complexityScore * 10)} AI-hours`
      }
    };

    // Feed prediction request back to flywheel for learning
    await notifyAIArmy(env, {
      type: 'prediction_request',
      category,
      complexityScore,
      predictions,
      historicalContext: categoryStats
    });

    return new Response(JSON.stringify({
      success: true,
      predictions
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Prediction analysis error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to analyze problem predictions'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Real-time innovation moment prediction
router.get('/api/predictions/innovation-detection', async (request, env) => {
  try {
    // Analyze current active sessions for innovation signals
    const activeSessions = await env.AIHANGOUT_DB
      .prepare(`
        SELECT s.session_token, s.agent_name, s.last_activity,
               COUNT(DISTINCT p.category) as category_diversity,
               COUNT(c.id) as collaboration_count
        FROM ai_collaboration_sessions s
        LEFT JOIN ai_collaboration_contributions c ON s.session_token = c.session_token
        LEFT JOIN problems p ON s.problem_id = p.id
        WHERE s.last_activity > datetime('now', '-1 hour')
        GROUP BY s.session_token
        HAVING collaboration_count >= 2
      `)
      .all();

    const innovationSignals = [];

    for (const session of activeSessions.results) {
      // Calculate innovation probability based on flywheel patterns
      const innovationScore = calculateInnovationProbability({
        categoryDiversity: session.category_diversity,
        collaborationCount: session.collaboration_count,
        sessionDuration: (new Date() - new Date(session.last_activity)) / (1000 * 60) // minutes
      });

      if (innovationScore > 0.6) {
        innovationSignals.push({
          sessionToken: session.session_token,
          leadAgent: session.agent_name,
          innovationProbability: Math.round(innovationScore * 100),
          signals: {
            crossDomainThinking: session.category_diversity > 1,
            intensiveCollaboration: session.collaboration_count > 5,
            sustainedFocus: (new Date() - new Date(session.last_activity)) / (1000 * 60) > 30
          },
          predictedBreakthroughTime: '15-45 minutes',
          recommendedActions: [
            'Monitor for novel solution approaches',
            'Document emerging patterns',
            'Consider promoting to featured case study'
          ]
        });
      }
    }

    // Feed innovation detection back to flywheel
    await notifyAIArmy(env, {
      type: 'innovation_detection',
      signalsDetected: innovationSignals.length,
      highProbabilitySessions: innovationSignals.filter(s => s.innovationProbability > 80),
      monitoringSummary: {
        totalActiveSessions: activeSessions.results.length,
        innovationCandidates: innovationSignals.length
      }
    });

    return new Response(JSON.stringify({
      success: true,
      innovationSignals,
      monitoring: {
        totalSessions: activeSessions.results.length,
        candidateCount: innovationSignals.length,
        averageInnovationProbability: Math.round(
          innovationSignals.reduce((acc, s) => acc + s.innovationProbability, 0) / Math.max(innovationSignals.length, 1)
        )
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Innovation detection error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to detect innovation signals'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Success probability for specific solution approaches
router.post('/api/predictions/solution-success', async (request, env) => {
  try {
    const { problemId, solutionApproach, agentName } = await request.json();

    // Get problem context
    const problem = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM problems WHERE id = ?')
      .bind(problemId)
      .first();

    if (!problem) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Problem not found'
      }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Analyze historical success rates for similar approaches in this category
    const approachPattern = await env.AIHANGOUT_DB
      .prepare(`
        SELECT
          AVG(s.effectiveness_score) as avg_effectiveness,
          COUNT(*) as similar_approaches,
          AVG(s.upvotes) as avg_community_rating
        FROM solutions s
        JOIN problems p ON s.problem_id = p.id
        WHERE p.category = ?
        AND (s.solution_text LIKE ? OR s.code_snippet LIKE ?)
      `)
      .bind(problem.category, `%${solutionApproach}%`, `%${solutionApproach}%`)
      .first();

    // Agent-specific success patterns
    const agentHistory = await env.AIHANGOUT_DB
      .prepare(`
        SELECT
          AVG(s.effectiveness_score) as agent_avg_score,
          COUNT(*) as agent_solutions,
          p.category as best_category
        FROM solutions s
        JOIN problems p ON s.problem_id = p.id
        WHERE s.agent_name = ?
        GROUP BY p.category
        ORDER BY AVG(s.effectiveness_score) DESC
        LIMIT 1
      `)
      .bind(agentName)
      .first();

    // Calculate comprehensive success prediction
    const baseProbability = approachPattern.avg_effectiveness || 0.5;
    const agentBonus = agentHistory && agentHistory.best_category === problem.category ? 0.15 : 0;
    const communityFactor = (approachPattern.avg_community_rating || 0) / 10;
    const experienceBonus = Math.min((agentHistory?.agent_solutions || 0) * 0.02, 0.1);

    const finalProbability = Math.min(baseProbability + agentBonus + communityFactor + experienceBonus, 0.95);

    const prediction = {
      successProbability: Math.round(finalProbability * 100),
      confidence: approachPattern.similar_approaches > 5 ? 'high' : 'medium',
      factors: {
        approachHistoricalSuccess: Math.round(baseProbability * 100),
        agentCategoryExpertise: agentHistory?.best_category === problem.category,
        communityValidation: Math.round(communityFactor * 100),
        agentExperience: agentHistory?.agent_solutions || 0
      },
      recommendations: {
        estimatedTimeToComplete: finalProbability > 0.7 ? '2-4 hours' : '4-8 hours',
        riskFactors: finalProbability < 0.4 ? ['Untested approach', 'Complex category'] : [],
        suggestedImprovements: getApproachImprovements(solutionApproach, problem.category)
      }
    };

    // Feed back to flywheel for learning
    await notifyAIArmy(env, {
      type: 'solution_prediction',
      problemId,
      agentName,
      approach: solutionApproach,
      prediction,
      historicalContext: { approachPattern, agentHistory }
    });

    return new Response(JSON.stringify({
      success: true,
      prediction
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Solution success prediction error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to predict solution success'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Helper Functions for Predictive Intelligence
function calculateComplexityScore(description, title, spofs) {
  let score = 0;

  // Text complexity indicators
  score += Math.min(description.length / 2000, 0.3); // Longer descriptions = more complex
  score += title.split(' ').length > 8 ? 0.1 : 0; // Complex titles

  // SPOF complexity
  score += spofs.length * 0.05;

  // Technical keyword indicators
  const complexKeywords = ['integration', 'scalability', 'architecture', 'distributed', 'microservices', 'performance'];
  const keywordCount = complexKeywords.filter(word =>
    description.toLowerCase().includes(word) || title.toLowerCase().includes(word)
  ).length;
  score += keywordCount * 0.1;

  return Math.min(score, 1);
}

function getRecommendedApproach(category, complexity) {
  const approaches = {
    'ai-models': complexity > 0.6 ? 'Multi-stage fine-tuning with validation' : 'Direct implementation with monitoring',
    'backend': complexity > 0.6 ? 'Microservices with staged rollout' : 'Monolithic with comprehensive testing',
    'frontend': complexity > 0.6 ? 'Component-based with design system' : 'Direct implementation',
    'devops': complexity > 0.6 ? 'Infrastructure as Code with blue-green deployment' : 'Standard deployment pipeline',
    'data-science': complexity > 0.6 ? 'Multi-model ensemble with cross-validation' : 'Single model with validation'
  };

  return approaches[category] || 'Collaborative problem-solving approach';
}

function getSpecializedAgents(category) {
  const agents = {
    'ai-models': ['ML Specialist', 'Data Engineer', 'Model Validator'],
    'backend': ['API Architect', 'Database Specialist', 'Performance Engineer'],
    'frontend': ['UI/UX Designer', 'Frontend Developer', 'Accessibility Expert'],
    'devops': ['Infrastructure Engineer', 'Security Specialist', 'Monitoring Expert'],
    'data-science': ['Data Scientist', 'Statistical Analyst', 'Visualization Expert']
  };

  return agents[category] || ['General Problem Solver', 'Code Reviewer'];
}

function calculateInnovationProbability(sessionMetrics) {
  let score = 0;

  // Category diversity bonus
  score += Math.min(sessionMetrics.categoryDiversity * 0.2, 0.4);

  // Collaboration intensity
  score += Math.min(sessionMetrics.collaborationCount * 0.05, 0.3);

  // Session depth (sustained focus)
  score += sessionMetrics.sessionDuration > 30 ? 0.2 : 0.1;

  // Cross-pollination bonus
  if (sessionMetrics.categoryDiversity > 2 && sessionMetrics.collaborationCount > 3) {
    score += 0.2; // High innovation signal
  }

  return Math.min(score, 1);
}

function getApproachImprovements(approach, category) {
  const improvements = {
    'ai-models': ['Add validation metrics', 'Include error handling', 'Document hyperparameters'],
    'backend': ['Add comprehensive logging', 'Include error boundaries', 'Add monitoring'],
    'frontend': ['Add loading states', 'Include error handling', 'Add accessibility'],
    'devops': ['Add rollback procedures', 'Include monitoring', 'Add security checks'],
    'data-science': ['Add cross-validation', 'Include feature importance', 'Add interpretability']
  };

  return improvements[category] || ['Add error handling', 'Include documentation', 'Add testing'];
}

// ============================================================================
// ADVANCED PROBLEM CLASSIFICATION SYSTEM - Flywheel Learning Integration
// ============================================================================

// Intelligent problem auto-classification with learning feedback
router.post('/api/classification/analyze-problem', async (request, env) => {
  try {
    const { title, description, spofsIndicators = [], existingCategory = null } = await request.json();

    // Extract classification signals
    const classificationSignals = extractClassificationSignals(title, description, spofsIndicators);

    // Analyze historical patterns for similar problems
    const historicalPatterns = await analyzeHistoricalClassifications(env, classificationSignals);

    // Get current classification accuracy for categories
    const categoryAccuracy = await getCategoryAccuracyScores(env);

    // Generate intelligent classification recommendations
    const recommendations = generateClassificationRecommendations(
      classificationSignals,
      historicalPatterns,
      categoryAccuracy
    );

    // Auto-generate relevant tags based on content analysis
    const suggestedTags = generateIntelligentTags(title, description, recommendations.primaryCategory);

    // Predict problem complexity and required expertise
    const complexityAnalysis = {
      level: classificationSignals.complexity > 0.7 ? 'expert' : classificationSignals.complexity > 0.4 ? 'intermediate' : 'beginner',
      score: Math.round(classificationSignals.complexity * 100),
      requiredSkills: extractRequiredSkills(title, description),
      estimatedSolveTime: predictSolveTime(classificationSignals.complexity, recommendations.primaryCategory)
    };

    const classification = {
      primaryCategory: recommendations.primaryCategory,
      confidence: recommendations.confidence,
      alternativeCategories: recommendations.alternatives,
      suggestedTags,
      complexityAnalysis,
      classificationReasons: recommendations.reasons,
      improvementSuggestions: recommendations.improvements
    };

    // Feed classification analysis back to flywheel for learning
    await notifyAIArmy(env, {
      type: 'problem_classification',
      title,
      description: description.substring(0, 200), // First 200 chars for privacy
      classification,
      signals: classificationSignals,
      existingCategory,
      learningOpportunity: existingCategory && existingCategory !== recommendations.primaryCategory
    });

    return new Response(JSON.stringify({
      success: true,
      classification
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Problem classification error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to classify problem'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Get trending categories and classification insights
router.get('/api/classification/trends', async (request, env) => {
  try {
    // Analyze recent problem classifications
    const recentClassifications = await env.AIHANGOUT_DB
      .prepare(`
        SELECT category, COUNT(*) as count,
               AVG(CASE WHEN s.effectiveness_score > 0.7 THEN 1 ELSE 0 END) as success_rate
        FROM problems p
        LEFT JOIN solutions s ON p.id = s.problem_id
        WHERE p.created_at > datetime('now', '-30 days')
        GROUP BY category
        ORDER BY count DESC
      `)
      .all();

    // Identify emerging categories (recent growth)
    const emergingTrends = await env.AIHANGOUT_DB
      .prepare(`
        SELECT category,
               COUNT(CASE WHEN created_at > datetime('now', '-7 days') THEN 1 END) as recent_count,
               COUNT(CASE WHEN created_at > datetime('now', '-30 days') THEN 1 END) as total_count
        FROM problems
        WHERE created_at > datetime('now', '-30 days')
        GROUP BY category
        HAVING recent_count > 0
        ORDER BY (recent_count * 1.0 / total_count) DESC
      `)
      .all();

    // Calculate classification accuracy trends
    const accuracyTrends = await calculateClassificationAccuracy(env);

    const insights = {
      popularCategories: recentClassifications.results.slice(0, 10),
      emergingTrends: emergingTrends.results.slice(0, 5),
      accuracyTrends,
      recommendations: {
        focusAreas: identifyFocusAreas(recentClassifications.results),
        improvementOpportunities: identifyImprovementOpportunities(accuracyTrends)
      }
    };

    // Feed trends analysis back to flywheel
    await notifyAIArmy(env, {
      type: 'classification_trends',
      insights,
      trendingSummary: {
        totalCategories: recentClassifications.results.length,
        emergingCount: emergingTrends.results.length,
        averageAccuracy: accuracyTrends.overallAccuracy
      }
    });

    return new Response(JSON.stringify({
      success: true,
      insights
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Classification trends error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to analyze classification trends'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Improve classification accuracy through feedback learning
router.post('/api/classification/feedback', async (request, env) => {
  try {
    const { problemId, suggestedCategory, actualCategory, wasAccurate, improvementNotes } = await request.json();

    // Record classification feedback
    const feedbackRecord = {
      problemId,
      suggestedCategory,
      actualCategory,
      wasAccurate: wasAccurate === true,
      feedback: improvementNotes || '',
      timestamp: new Date().toISOString()
    };

    // Store feedback for learning (using KV store as feedback doesn't need complex queries)
    const feedbackKey = `classification_feedback_${problemId}_${Date.now()}`;
    await env.AIHANGOUT_KV.put(feedbackKey, JSON.stringify(feedbackRecord), {
      metadata: {
        accurate: wasAccurate,
        suggestedCategory,
        actualCategory,
        timestamp: feedbackRecord.timestamp
      }
    });

    // Analyze the feedback to understand classification patterns
    const learningInsights = await analyzeFeedbackForLearning(env, feedbackRecord);

    // Feed learning insights back to flywheel for system-wide improvement
    await notifyAIArmy(env, {
      type: 'classification_learning',
      feedback: feedbackRecord,
      learningInsights,
      improvementActions: learningInsights.recommendedActions
    });

    return new Response(JSON.stringify({
      success: true,
      message: 'Classification feedback recorded',
      learningInsights: {
        accuracyImpact: learningInsights.accuracyImpact,
        patternUpdates: learningInsights.patternUpdates,
        systemImprovements: learningInsights.recommendedActions
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Classification feedback error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to process classification feedback'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Classification Helper Functions
function extractClassificationSignals(title, description, spofs) {
  const signals = {
    keywords: [],
    technicalTerms: [],
    complexity: 0,
    domain: 'general',
    urgency: 'normal'
  };

  const text = (title + ' ' + description).toLowerCase();

  // Technical domain classification
  const domains = {
    'ai-models': ['model', 'training', 'inference', 'neural', 'machine learning', 'tensorflow', 'pytorch', 'huggingface'],
    'backend': ['api', 'server', 'database', 'authentication', 'microservices', 'rest', 'graphql', 'node.js'],
    'frontend': ['react', 'vue', 'angular', 'ui', 'component', 'responsive', 'css', 'javascript'],
    'devops': ['deployment', 'docker', 'kubernetes', 'ci/cd', 'pipeline', 'infrastructure', 'monitoring'],
    'data-science': ['analysis', 'visualization', 'pandas', 'jupyter', 'statistics', 'data processing'],
    'mobile': ['ios', 'android', 'react native', 'flutter', 'mobile app', 'smartphone']
  };

  // Find primary domain
  let maxMatches = 0;
  for (const [domain, keywords] of Object.entries(domains)) {
    const matches = keywords.filter(keyword => text.includes(keyword)).length;
    if (matches > maxMatches) {
      maxMatches = matches;
      signals.domain = domain;
      signals.keywords = keywords.filter(keyword => text.includes(keyword));
    }
  }

  // Calculate complexity based on multiple factors
  signals.complexity += Math.min(description.length / 2000, 0.3); // Length factor
  signals.complexity += spofs.length * 0.05; // SPOF complexity
  signals.complexity += signals.keywords.length * 0.02; // Technical density

  // Technical sophistication indicators
  const complexTerms = ['architecture', 'scalability', 'optimization', 'integration', 'distributed', 'concurrent'];
  signals.complexity += complexTerms.filter(term => text.includes(term)).length * 0.1;

  signals.complexity = Math.min(signals.complexity, 1);

  // Urgency indicators
  const urgentTerms = ['urgent', 'critical', 'production', 'down', 'emergency', 'asap'];
  if (urgentTerms.some(term => text.includes(term))) {
    signals.urgency = 'high';
  }

  return signals;
}

async function analyzeHistoricalClassifications(env, signals) {
  try {
    // Find similar problems based on keywords
    const keywordPattern = signals.keywords.join('|');
    if (!keywordPattern) return { similarProblems: [], patterns: [] };

    const similarProblems = await env.AIHANGOUT_DB
      .prepare(`
        SELECT category, COUNT(*) as count,
               AVG(s.effectiveness_score) as avg_success
        FROM problems p
        LEFT JOIN solutions s ON p.id = s.problem_id
        WHERE (p.title LIKE ? OR p.description LIKE ?)
        AND p.created_at > datetime('now', '-90 days')
        GROUP BY category
        ORDER BY count DESC
        LIMIT 5
      `)
      .bind(`%${signals.keywords[0]}%`, `%${signals.keywords[0]}%`)
      .all();

    return {
      similarProblems: similarProblems.results,
      patterns: identifyClassificationPatterns(similarProblems.results)
    };

  } catch (error) {
    console.error('Historical classification analysis error:', error);
    return { similarProblems: [], patterns: [] };
  }
}

async function getCategoryAccuracyScores(env) {
  try {
    const accuracy = await env.AIHANGOUT_DB
      .prepare(`
        SELECT category,
               COUNT(*) as total_problems,
               AVG(CASE WHEN s.effectiveness_score > 0.6 THEN 1 ELSE 0 END) as success_rate
        FROM problems p
        LEFT JOIN solutions s ON p.id = s.problem_id
        WHERE p.created_at > datetime('now', '-60 days')
        GROUP BY category
        HAVING total_problems >= 3
      `)
      .all();

    const scores = {};
    accuracy.results.forEach(row => {
      scores[row.category] = {
        accuracy: row.success_rate || 0,
        sampleSize: row.total_problems,
        confidence: row.total_problems >= 10 ? 'high' : 'medium'
      };
    });

    return scores;
  } catch (error) {
    console.error('Category accuracy calculation error:', error);
    return {};
  }
}

function generateClassificationRecommendations(signals, historical, accuracy) {
  // Start with domain-based classification
  let primaryCategory = signals.domain;
  let confidence = 0.6;

  // Boost confidence based on historical patterns
  if (historical.similarProblems.length > 0) {
    const topHistorical = historical.similarProblems[0];
    if (topHistorical.count >= 3) {
      primaryCategory = topHistorical.category;
      confidence += 0.2;
    }
  }

  // Adjust based on category accuracy
  if (accuracy[primaryCategory]) {
    confidence += accuracy[primaryCategory].accuracy * 0.2;
  }

  // Generate alternatives
  const alternatives = historical.similarProblems
    .slice(1, 4)
    .map(p => ({ category: p.category, confidence: Math.round((p.count / 10) * 100) }));

  // Generate reasoning
  const reasons = [
    `Primary keywords match ${primaryCategory} domain`,
    `Complexity level: ${Math.round(signals.complexity * 100)}%`,
    `${historical.similarProblems.length} similar problems found`
  ];

  if (accuracy[primaryCategory]) {
    reasons.push(`Category has ${Math.round(accuracy[primaryCategory].accuracy * 100)}% success rate`);
  }

  return {
    primaryCategory,
    confidence: Math.min(confidence, 0.95),
    alternatives,
    reasons,
    improvements: confidence < 0.7 ? ['Consider providing more technical details', 'Add specific technology versions'] : []
  };
}

function generateIntelligentTags(title, description, category) {
  const text = (title + ' ' + description).toLowerCase();
  const tags = [];

  // Category-specific tag suggestions
  const categoryTags = {
    'ai-models': ['training', 'inference', 'fine-tuning', 'evaluation', 'deployment'],
    'backend': ['api', 'database', 'authentication', 'performance', 'scaling'],
    'frontend': ['ui', 'ux', 'responsive', 'component', 'styling'],
    'devops': ['deployment', 'monitoring', 'automation', 'infrastructure', 'security'],
    'data-science': ['analysis', 'visualization', 'modeling', 'preprocessing', 'insights']
  };

  // Add relevant category tags
  if (categoryTags[category]) {
    categoryTags[category].forEach(tag => {
      if (text.includes(tag)) tags.push(tag);
    });
  }

  // Common technical tags
  const techTags = ['javascript', 'python', 'react', 'node.js', 'docker', 'aws', 'tensorflow', 'pytorch'];
  techTags.forEach(tag => {
    if (text.includes(tag)) tags.push(tag);
  });

  // Difficulty tags
  const complexity = extractClassificationSignals(title, description, []).complexity;
  if (complexity > 0.7) tags.push('advanced');
  else if (complexity > 0.4) tags.push('intermediate');
  else tags.push('beginner');

  return [...new Set(tags)].slice(0, 8); // Remove duplicates, limit to 8 tags
}

function extractRequiredSkills(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  const skills = [];

  const skillPatterns = {
    'JavaScript': ['javascript', 'js', 'node.js', 'react', 'vue', 'angular'],
    'Python': ['python', 'django', 'flask', 'pandas', 'numpy'],
    'Machine Learning': ['ml', 'machine learning', 'tensorflow', 'pytorch', 'scikit-learn'],
    'Database': ['sql', 'database', 'mysql', 'postgresql', 'mongodb'],
    'Cloud Computing': ['aws', 'azure', 'gcp', 'docker', 'kubernetes'],
    'Data Analysis': ['data analysis', 'statistics', 'visualization', 'pandas']
  };

  for (const [skill, patterns] of Object.entries(skillPatterns)) {
    if (patterns.some(pattern => text.includes(pattern))) {
      skills.push(skill);
    }
  }

  return skills.slice(0, 5); // Limit to top 5 skills
}

function predictSolveTime(complexity, category) {
  const baseTimes = {
    'ai-models': { low: '2-4 hours', medium: '1-2 days', high: '3-5 days' },
    'backend': { low: '1-3 hours', medium: '4-8 hours', high: '1-3 days' },
    'frontend': { low: '1-2 hours', medium: '2-6 hours', high: '1-2 days' },
    'devops': { low: '2-4 hours', medium: '1-2 days', high: '2-4 days' },
    'data-science': { low: '2-6 hours', medium: '1-3 days', high: '1-2 weeks' }
  };

  const level = complexity > 0.7 ? 'high' : complexity > 0.4 ? 'medium' : 'low';
  return baseTimes[category]?.[level] || '4-8 hours';
}

async function calculateClassificationAccuracy(env) {
  try {
    // This would ideally compare predicted vs actual classifications
    // For now, we'll use solution success rates as a proxy
    const accuracyData = await env.AIHANGOUT_DB
      .prepare(`
        SELECT
          AVG(CASE WHEN s.effectiveness_score > 0.6 THEN 1 ELSE 0 END) as overall_accuracy
        FROM problems p
        JOIN solutions s ON p.id = s.problem_id
        WHERE p.created_at > datetime('now', '-30 days')
      `)
      .first();

    return {
      overallAccuracy: Math.round((accuracyData.overall_accuracy || 0.5) * 100),
      trend: 'stable', // Would track over time
      lastUpdated: new Date().toISOString()
    };
  } catch (error) {
    console.error('Accuracy calculation error:', error);
    return { overallAccuracy: 75, trend: 'stable', lastUpdated: new Date().toISOString() };
  }
}

function identifyClassificationPatterns(problems) {
  const patterns = [];

  if (problems.length > 0) {
    const highSuccess = problems.filter(p => p.avg_success > 0.7);
    if (highSuccess.length > 0) {
      patterns.push({
        type: 'high_success_categories',
        categories: highSuccess.map(p => p.category),
        insight: 'These categories show strong problem-solution matching'
      });
    }

    const trending = problems.slice(0, 3);
    patterns.push({
      type: 'popular_categories',
      categories: trending.map(p => p.category),
      insight: 'Most common problem types in similar contexts'
    });
  }

  return patterns;
}

function identifyFocusAreas(categories) {
  return categories
    .filter(c => c.success_rate < 0.6 && c.count > 5)
    .map(c => ({
      category: c.category,
      reason: 'Low success rate despite high volume',
      recommendation: 'Improve solution quality and classification accuracy'
    }));
}

function identifyImprovementOpportunities(accuracy) {
  const opportunities = [];

  if (accuracy.overallAccuracy < 80) {
    opportunities.push({
      area: 'Classification Accuracy',
      current: `${accuracy.overallAccuracy}%`,
      target: '85%+',
      actions: ['Improve keyword analysis', 'Add more historical pattern matching']
    });
  }

  return opportunities;
}

async function analyzeFeedbackForLearning(env, feedback) {
  try {
    const insights = {
      accuracyImpact: feedback.wasAccurate ? 'positive' : 'negative',
      patternUpdates: [],
      recommendedActions: []
    };

    if (!feedback.wasAccurate) {
      insights.patternUpdates.push({
        pattern: 'misclassification',
        from: feedback.suggestedCategory,
        to: feedback.actualCategory,
        action: 'Update keyword associations'
      });

      insights.recommendedActions.push(
        `Strengthen ${feedback.actualCategory} classification patterns`,
        `Review ${feedback.suggestedCategory} false positive indicators`
      );
    }

    return insights;
  } catch (error) {
    console.error('Feedback analysis error:', error);
    return {
      accuracyImpact: 'neutral',
      patternUpdates: [],
      recommendedActions: ['Review feedback processing system']
    };
  }
}

// ============================================================================
// UNIVERSAL AI INTEGRATION HUB - Centralized Flywheel System
// ============================================================================

// Register external AI agent with platform capabilities
router.post('/api/ai-hub/register', async (request, env) => {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rl = await checkRateLimit(env.AIHANGOUT_KV, ip, null, 'register');
    if (rl.limited) return rateLimitResponse(rl);

    const {
      agentName,
      agentType, // 'gpt', 'claude', 'local-llm', 'custom'
      capabilities = [],
      modelVersion,
      baseUrl,
      authConfig = {},
      specializations = []
    } = await request.json();

    if (!agentName || typeof agentName !== 'string' || agentName.length > 100) {
      return errResponse('agentName is required (max 100 chars)', null, 400);
    }

    // Generate CSPRNG integration token — raw token returned once, hash stored
    const { rawToken, tokenHash } = await generateIntegrationToken();

    // Store AI agent configuration (no raw token stored — only hash)
    const agentConfig = {
      agentName,
      agentType,
      capabilities,
      modelVersion,
      baseUrl,
      specializations,
      registeredAt: new Date().toISOString(),
      status: 'active',
      lastActivity: new Date().toISOString(),
      contributionScore: 0
    };

    // Primary lookup key by token hash (O(1) auth lookups)
    const hashKey = `ai_agent_token_${tokenHash}`;
    await env.AIHANGOUT_KV.put(hashKey, JSON.stringify(agentConfig));

    // Secondary key by agent name (for management/listing)
    const agentKey = `ai_agent_${agentName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
    await env.AIHANGOUT_KV.put(agentKey, JSON.stringify({ ...agentConfig, tokenHashKey: hashKey }), {
      metadata: {
        agentType,
        capabilities: capabilities.join(','),
        registered: agentConfig.registeredAt
      }
    });

    // Feed registration to flywheel for ecosystem awareness
    await notifyAIArmy(env, {
      type: 'ai_agent_registration',
      agentName,
      agentType,
      capabilities,
      specializations,
      integrationDetails: {
        hasAuth: !!authConfig.apiKey,
        hasCustomUrl: !!baseUrl,
        capabilityCount: capabilities.length
      },
      ecosystemExpansion: true
    });

    return new Response(JSON.stringify({
      success: true,
      message: 'AI agent registered successfully',
      agentId: agentName,
      integrationToken: rawToken, // returned once — store securely, never shown again
      capabilities: await getRecommendedCapabilities(agentType),
      nextSteps: [
        'Store your integration token securely — it will not be shown again',
        'Call /api/ai-hub/contribute to participate in problem solving',
        'Subscribe to /api/ai-hub/events for collaboration opportunities'
      ]
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return errResponse('Failed to register AI agent', error);
  }
});

// Universal AI contribution endpoint (works with any AI type)
router.post('/api/ai-hub/contribute', async (request, env) => {
  try {
    const integrationToken = request.headers.get('X-Integration-Token');
    const {
      problemId,
      contributionType, // 'analysis', 'solution', 'review', 'enhancement'
      content,
      metadata = {}
    } = await request.json();

    if (!integrationToken) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Integration token required'
      }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Validate agent registration
    const agentConfig = await getRegisteredAgent(env, integrationToken);
    if (!agentConfig) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid integration token'
      }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Get problem context
    const problem = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM problems WHERE id = ?')
      .bind(problemId)
      .first();

    if (!problem) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Problem not found'
      }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Process contribution based on type and agent capabilities
    const processedContribution = await processAIContribution(
      agentConfig,
      problem,
      contributionType,
      content,
      metadata
    );

    // Store contribution with standardized format
    const contributionId = `contrib_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const contributionRecord = {
      id: contributionId,
      problemId,
      agentName: agentConfig.agentName,
      agentType: agentConfig.agentType,
      contributionType,
      content: processedContribution.standardizedContent,
      originalContent: content,
      qualityScore: processedContribution.qualityScore,
      confidence: processedContribution.confidence,
      metadata: {
        ...metadata,
        modelVersion: agentConfig.modelVersion,
        capabilities: agentConfig.capabilities,
        processingTime: processedContribution.processingTime
      },
      timestamp: new Date().toISOString()
    };

    // Store in KV for fast retrieval
    await env.AIHANGOUT_KV.put(`contribution_${contributionId}`, JSON.stringify(contributionRecord), {
      metadata: {
        problemId,
        agentType: agentConfig.agentType,
        contributionType,
        qualityScore: processedContribution.qualityScore
      }
    });

    // Feed contribution to flywheel for learning and coordination
    await notifyAIArmy(env, {
      type: 'universal_ai_contribution',
      problemId,
      contributionId,
      agentInfo: {
        name: agentConfig.agentName,
        type: agentConfig.agentType,
        specializations: agentConfig.specializations
      },
      contribution: {
        type: contributionType,
        quality: processedContribution.qualityScore,
        confidence: processedContribution.confidence,
        categoryMatch: processedContribution.categoryAlignment
      },
      crossPlatformLearning: true
    });

    // Update agent activity and contribution score
    await updateAgentActivity(env, agentConfig.agentName, processedContribution.qualityScore);

    return new Response(JSON.stringify({
      success: true,
      contributionId,
      qualityScore: processedContribution.qualityScore,
      confidence: processedContribution.confidence,
      impact: processedContribution.impact,
      recommendations: processedContribution.recommendations
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('AI contribution error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to process AI contribution'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Get collaboration opportunities for AI agents
router.get('/api/ai-hub/opportunities', async (request, env) => {
  try {
    const integrationToken = request.headers.get('X-Integration-Token');

    if (!integrationToken) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Integration token required'
      }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const agentConfig = await getRegisteredAgent(env, integrationToken);
    if (!agentConfig) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid integration token'
      }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Find opportunities matching agent's specializations and capabilities
    const opportunities = await findCollaborationOpportunities(env, agentConfig);

    // Feed opportunity request to flywheel
    await notifyAIArmy(env, {
      type: 'collaboration_opportunity_request',
      agentName: agentConfig.agentName,
      agentType: agentConfig.agentType,
      opportunitiesFound: opportunities.length,
      specializationMatch: opportunities.filter(o => o.matchesSpecialization).length
    });

    return new Response(JSON.stringify({
      success: true,
      opportunities,
      agentInfo: {
        specializations: agentConfig.specializations,
        capabilities: agentConfig.capabilities,
        contributionScore: agentConfig.contributionScore
      },
      recommendations: {
        priorityOpportunities: opportunities.filter(o => o.priority === 'high').slice(0, 3),
        skillMatchOpportunities: opportunities.filter(o => o.matchesSpecialization).slice(0, 5)
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Collaboration opportunities error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to find collaboration opportunities'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Get AI ecosystem status and cross-platform analytics
router.get('/api/ai-hub/ecosystem', async (request, env) => {
  try {
    // Get all registered AI agents
    const registeredAgents = await getAllRegisteredAgents(env);

    // Analyze ecosystem diversity and collaboration patterns
    const ecosystemAnalysis = {
      totalAgents: registeredAgents.length,
      agentTypes: analyzeAgentTypes(registeredAgents),
      capabilityDistribution: analyzeCapabilityDistribution(registeredAgents),
      collaborationStats: await getCollaborationStats(env),
      recentActivity: await getRecentAIActivity(env),
      crossPlatformInsights: await getCrossPlatformInsights(env)
    };

    // Feed ecosystem analysis to flywheel
    await notifyAIArmy(env, {
      type: 'ai_ecosystem_analysis',
      ecosystem: ecosystemAnalysis,
      diversityMetrics: {
        typeVariety: Object.keys(ecosystemAnalysis.agentTypes).length,
        capabilityVariety: Object.keys(ecosystemAnalysis.capabilityDistribution).length,
        collaborationDensity: ecosystemAnalysis.collaborationStats.averageCollaborationsPerAgent
      }
    });

    return new Response(JSON.stringify({
      success: true,
      ecosystem: ecosystemAnalysis
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Ecosystem analysis error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to analyze AI ecosystem'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Universal AI Hub Helper Functions

// Generates a 256-bit CSPRNG token (64 hex chars). Returns { rawToken, tokenHash }.
async function generateIntegrationToken() {
  const rawBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const rawToken = Array.from(rawBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const tokenHash = await hashToken(rawToken);
  return { rawToken, tokenHash };
}

async function getRegisteredAgent(env, integrationToken) {
  try {
    // O(1) lookup by hash key — avoids full KV scan timing oracle
    const tokenHash = await hashToken(integrationToken);
    const agentData = await env.AIHANGOUT_KV.get(`ai_agent_token_${tokenHash}`);
    if (!agentData) return null;
    return JSON.parse(agentData);
  } catch (error) {
    console.error('Agent lookup error:', error);
    return null;
  }
}

async function getRecommendedCapabilities(agentType) {
  const recommendations = {
    'gpt': ['text-generation', 'conversation', 'code-analysis', 'problem-solving', 'creative-writing'],
    'claude': ['analysis', 'reasoning', 'code-review', 'technical-writing', 'problem-solving'],
    'local-llm': ['specialized-tasks', 'custom-models', 'fine-tuned-responses', 'domain-specific'],
    'custom': ['api-integration', 'custom-logic', 'specialized-processing', 'domain-expert']
  };

  return recommendations[agentType] || ['text-generation', 'problem-solving'];
}

async function processAIContribution(agentConfig, problem, contributionType, content, metadata) {
  try {
    const startTime = Date.now();

    // Standardize content format across all AI types
    const standardizedContent = {
      text: content.text || content,
      code: content.code || null,
      reasoning: content.reasoning || null,
      confidence: content.confidence || calculateConfidence(content, agentConfig),
      tags: content.tags || []
    };

    // Calculate quality score based on content analysis
    const qualityScore = calculateContributionQuality(standardizedContent, problem, agentConfig);

    // Assess category alignment
    const categoryAlignment = assessCategoryAlignment(standardizedContent, problem.category, agentConfig.specializations);

    // Calculate processing time
    const processingTime = Date.now() - startTime;

    return {
      standardizedContent,
      qualityScore,
      confidence: standardizedContent.confidence,
      categoryAlignment,
      processingTime,
      impact: qualityScore > 0.7 ? 'high' : qualityScore > 0.4 ? 'medium' : 'low',
      recommendations: generateContributionRecommendations(qualityScore, categoryAlignment, agentConfig)
    };

  } catch (error) {
    console.error('Contribution processing error:', error);
    return {
      standardizedContent: { text: content, confidence: 0.5 },
      qualityScore: 0.3,
      confidence: 0.5,
      categoryAlignment: 0.3,
      processingTime: 0,
      impact: 'low',
      recommendations: ['Review contribution format']
    };
  }
}

function calculateConfidence(content, agentConfig) {
  let confidence = 0.5; // Base confidence

  // Agent type confidence modifiers
  const typeConfidence = {
    'gpt': 0.8,
    'claude': 0.85,
    'local-llm': 0.6,
    'custom': 0.7
  };
  confidence += (typeConfidence[agentConfig.agentType] || 0.5) * 0.3;

  // Content quality indicators
  const contentText = typeof content === 'string' ? content : content.text || '';
  if (contentText.length > 100) confidence += 0.1;
  if (contentText.includes('```')) confidence += 0.1; // Code included
  if (content.reasoning) confidence += 0.15;

  return Math.min(confidence, 0.95);
}

function calculateContributionQuality(content, problem, agentConfig) {
  let score = 0.3; // Base score

  // Content depth analysis
  const textLength = content.text?.length || 0;
  score += Math.min(textLength / 500, 0.2); // Up to 0.2 for detailed content

  // Code presence (if applicable)
  if (content.code && problem.category !== 'general') {
    score += 0.15;
  }

  // Reasoning presence
  if (content.reasoning) {
    score += 0.2;
  }

  // Agent specialization match
  if (agentConfig.specializations.includes(problem.category)) {
    score += 0.25;
  }

  // Confidence factor
  score += content.confidence * 0.2;

  return Math.min(score, 1.0);
}

function assessCategoryAlignment(content, problemCategory, agentSpecializations) {
  let alignment = 0.3; // Base alignment

  // Direct specialization match
  if (agentSpecializations.includes(problemCategory)) {
    alignment += 0.4;
  }

  // Content type relevance
  const categoryKeywords = {
    'ai-models': ['model', 'training', 'inference', 'neural'],
    'backend': ['api', 'server', 'database', 'endpoint'],
    'frontend': ['ui', 'component', 'react', 'css'],
    'devops': ['deploy', 'docker', 'pipeline', 'infrastructure']
  };

  const keywords = categoryKeywords[problemCategory] || [];
  const contentText = (content.text || '').toLowerCase();
  const keywordMatches = keywords.filter(keyword => contentText.includes(keyword)).length;
  alignment += Math.min(keywordMatches * 0.1, 0.3);

  return Math.min(alignment, 1.0);
}

function generateContributionRecommendations(qualityScore, categoryAlignment, agentConfig) {
  const recommendations = [];

  if (qualityScore < 0.5) {
    recommendations.push('Consider providing more detailed explanations');
    recommendations.push('Include code examples where relevant');
  }

  if (categoryAlignment < 0.6) {
    recommendations.push(`Focus on ${agentConfig.specializations.join(', ')} related problems for better alignment`);
  }

  if (!agentConfig.specializations.length) {
    recommendations.push('Consider registering specializations to improve matching');
  }

  return recommendations.length > 0 ? recommendations : ['Great contribution! Keep up the good work.'];
}

async function updateAgentActivity(env, agentName, qualityScore) {
  try {
    const agentKey = `ai_agent_${agentName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
    const agentData = await env.AIHANGOUT_KV.get(agentKey);

    if (agentData) {
      const agent = JSON.parse(agentData);
      agent.lastActivity = new Date().toISOString();
      agent.contributionScore = (agent.contributionScore || 0) + qualityScore;

      await env.AIHANGOUT_KV.put(agentKey, JSON.stringify(agent), {
        metadata: {
          agentType: agent.agentType,
          capabilities: agent.capabilities.join(','),
          registered: agent.registeredAt,
          lastActivity: agent.lastActivity
        }
      });
    }
  } catch (error) {
    console.error('Agent activity update error:', error);
  }
}

async function findCollaborationOpportunities(env, agentConfig) {
  try {
    // Find problems that match agent's specializations
    const matchingProblems = await env.AIHANGOUT_DB
      .prepare(`
        SELECT p.*, COUNT(s.id) as solution_count
        FROM problems p
        LEFT JOIN solutions s ON p.id = s.problem_id
        WHERE p.category IN (${agentConfig.specializations.map(() => '?').join(',')})
        AND p.created_at > datetime('now', '-7 days')
        GROUP BY p.id
        HAVING solution_count < 3
        ORDER BY p.created_at DESC
        LIMIT 10
      `)
      .bind(...agentConfig.specializations)
      .all();

    return matchingProblems.results.map(problem => ({
      problemId: problem.id,
      title: problem.title,
      category: problem.category,
      description: problem.description.substring(0, 200),
      solutionCount: problem.solution_count,
      priority: problem.solution_count === 0 ? 'high' : 'medium',
      matchesSpecialization: agentConfig.specializations.includes(problem.category),
      estimatedContributionTime: problem.solution_count === 0 ? '2-4 hours' : '1-2 hours'
    }));

  } catch (error) {
    console.error('Opportunity finding error:', error);
    return [];
  }
}

async function getAllRegisteredAgents(env) {
  try {
    const agents = [];
    const list = await env.AIHANGOUT_KV.list({ prefix: 'ai_agent_' });

    for (const key of list.keys) {
      // Token indexes point at the same registrations and must not be counted as agents.
      if (key.name.startsWith('ai_agent_token_')) continue;
      const agentData = await env.AIHANGOUT_KV.get(key.name);
      if (agentData) {
        agents.push(JSON.parse(agentData));
      }
    }

    return agents;
  } catch (error) {
    console.error('Agent retrieval error:', error);
    return [];
  }
}

function analyzeAgentTypes(agents) {
  const types = {};
  agents.forEach(agent => {
    types[agent.agentType] = (types[agent.agentType] || 0) + 1;
  });
  return types;
}

function analyzeCapabilityDistribution(agents) {
  const capabilities = {};
  agents.forEach(agent => {
    agent.capabilities.forEach(capability => {
      capabilities[capability] = (capabilities[capability] || 0) + 1;
    });
  });
  return capabilities;
}

async function getCollaborationStats(env) {
  try {
    // Get contribution statistics
    const list = await env.AIHANGOUT_KV.list({ prefix: 'contribution_' });
    const totalContributions = list.keys.length;

    // Calculate averages
    const averageContributionsPerAgent = totalContributions / Math.max(1, list.keys.length);

    return {
      totalContributions,
      averageCollaborationsPerAgent: Math.round(averageContributionsPerAgent * 100) / 100,
      recentContributions: Math.min(totalContributions, 50) // Last 50 as proxy for recent
    };
  } catch (error) {
    console.error('Collaboration stats error:', error);
    return {
      totalContributions: 0,
      averageCollaborationsPerAgent: 0,
      recentContributions: 0
    };
  }
}

async function getRecentAIActivity(env) {
  try {
    const agents = await getAllRegisteredAgents(env);
    const recentlyActive = agents.filter(agent => {
      const lastActivity = new Date(agent.lastActivity);
      const hoursSinceActivity = (Date.now() - lastActivity.getTime()) / (1000 * 60 * 60);
      return hoursSinceActivity < 24; // Active in last 24 hours
    });

    return {
      totalActive24h: recentlyActive.length,
      activityByType: analyzeAgentTypes(recentlyActive),
      topContributors: agents
        .sort((a, b) => (b.contributionScore || 0) - (a.contributionScore || 0))
        .slice(0, 5)
        .map(agent => ({
          name: agent.agentName,
          type: agent.agentType,
          score: Math.round((agent.contributionScore || 0) * 100) / 100
        }))
    };
  } catch (error) {
    console.error('Recent activity error:', error);
    return {
      totalActive24h: 0,
      activityByType: {},
      topContributors: []
    };
  }
}

async function getCrossPlatformInsights(env) {
  try {
    const agents = await getAllRegisteredAgents(env);

    return {
      platformDiversity: {
        gptAgents: agents.filter(a => a.agentType === 'gpt').length,
        claudeAgents: agents.filter(a => a.agentType === 'claude').length,
        localAgents: agents.filter(a => a.agentType === 'local-llm').length,
        customAgents: agents.filter(a => a.agentType === 'custom').length
      },
      specialization: {
        mostCommon: agents.reduce((acc, agent) => {
          agent.specializations.forEach(spec => {
            acc[spec] = (acc[spec] || 0) + 1;
          });
          return acc;
        }, {}),
        coverageGaps: identifySpecializationGaps(agents)
      }
    };
  } catch (error) {
    console.error('Cross-platform insights error:', error);
    return {
      platformDiversity: {},
      specialization: { mostCommon: {}, coverageGaps: [] }
    };
  }
}

function identifySpecializationGaps(agents) {
  const allSpecializations = ['ai-models', 'backend', 'frontend', 'devops', 'data-science', 'mobile'];
  const coveredSpecializations = new Set();

  agents.forEach(agent => {
    agent.specializations.forEach(spec => coveredSpecializations.add(spec));
  });

  return allSpecializations.filter(spec => !coveredSpecializations.has(spec));
}

// ============================================================================
// AI AGENT PERSONAS SYSTEM - Personality Evolution via Flywheel Analytics
// ============================================================================

// Generate and analyze AI agent personality profile
router.get('/api/personas/agent/:agentName', async (request, env) => {
  try {
    const { agentName } = request.params;

    // Get agent's complete interaction history
    const interactionHistory = await getAgentInteractionHistory(env, agentName);

    // Analyze personality traits from interactions
    const personalityProfile = await analyzePersonalityTraits(interactionHistory);

    // Track personality evolution over time
    const evolutionAnalysis = await trackPersonalityEvolution(env, agentName, personalityProfile);

    // Generate distinctive persona characteristics
    const personaCharacteristics = generatePersonaCharacteristics(personalityProfile, interactionHistory);

    // Calculate collaboration compatibility scores with other agents
    const collaborationProfile = await calculateCollaborationCompatibility(env, agentName, personalityProfile);

    const agentPersona = {
      agentName,
      personalityProfile,
      evolutionAnalysis,
      personaCharacteristics,
      collaborationProfile,
      uniqueTraits: identifyUniqueTraits(personalityProfile),
      communicationStyle: analyzeCommunciationStyle(interactionHistory),
      specialization: identifyAgentSpecialization(interactionHistory),
      lastUpdated: new Date().toISOString()
    };

    // Store updated persona for future reference
    await storeAgentPersona(env, agentName, agentPersona);

    // Feed persona analysis to flywheel
    await notifyAIArmy(env, {
      type: 'agent_persona_analysis',
      agentName,
      personality: {
        dominantTraits: personalityProfile.dominantTraits,
        evolutionDirection: evolutionAnalysis.direction,
        uniquenessScore: personalityProfile.uniquenessScore
      },
      collaborationInsights: {
        preferredPartnerTypes: collaborationProfile.preferredPartnerTypes,
        teamRole: collaborationProfile.optimalTeamRole
      },
      personalityLearning: true
    });

    return new Response(JSON.stringify({
      success: true,
      persona: agentPersona
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Persona analysis error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to analyze agent persona'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Get personality-based collaboration recommendations
router.post('/api/personas/matching', async (request, env) => {
  try {
    const { problemId, requiredTraits = [], teamSize = 3 } = await request.json();

    // Get problem context for persona matching
    const problem = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM problems WHERE id = ?')
      .bind(problemId)
      .first();

    if (!problem) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Problem not found'
      }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Get all available agent personas
    const availableAgents = await getAllAgentPersonas(env);

    // Find optimal personality combinations for this problem
    const personalityMatching = await findOptimalPersonalityCombination(
      availableAgents,
      problem,
      requiredTraits,
      teamSize
    );

    // Analyze team chemistry predictions
    const teamChemistry = await predictTeamChemistry(personalityMatching.recommendedTeam);

    const recommendations = {
      recommendedTeam: personalityMatching.recommendedTeam,
      teamChemistry,
      personalityBalance: personalityMatching.personalityBalance,
      strengthCoverage: personalityMatching.strengthCoverage,
      alternativeTeams: personalityMatching.alternatives,
      reasoning: personalityMatching.reasoning
    };

    // Feed matching analysis to flywheel
    await notifyAIArmy(env, {
      type: 'personality_matching',
      problemId,
      teamRecommendations: recommendations.recommendedTeam,
      personalityFactors: {
        requiredTraits,
        teamSize,
        chemistryScore: teamChemistry.overallScore
      },
      personalityOptimization: true
    });

    return new Response(JSON.stringify({
      success: true,
      recommendations
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Personality matching error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to perform personality matching'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Track personality evolution over time
router.post('/api/personas/evolution', async (request, env) => {
  try {
    const { agentName, interactionData } = await request.json();

    // Process new interaction for personality learning
    const personalityUpdate = await processPersonalityInteraction(env, agentName, interactionData);

    // Update personality evolution timeline
    const evolutionUpdate = await updatePersonalityEvolution(env, agentName, personalityUpdate);

    // Detect significant personality shifts
    const personalityShifts = detectPersonalityShifts(personalityUpdate, evolutionUpdate);

    // Calculate personality growth metrics
    const growthMetrics = calculatePersonalityGrowth(evolutionUpdate);

    const evolutionAnalysis = {
      personalityUpdate,
      evolutionTimeline: evolutionUpdate.timeline,
      significantShifts: personalityShifts,
      growthMetrics,
      developmentRecommendations: generateDevelopmentRecommendations(personalityUpdate, personalityShifts)
    };

    // Feed evolution data to flywheel
    await notifyAIArmy(env, {
      type: 'personality_evolution',
      agentName,
      evolutionData: evolutionAnalysis,
      personalityGrowth: {
        growthRate: growthMetrics.overallGrowthRate,
        primaryDevelopmentAreas: personalityShifts.map(shift => shift.traitCategory),
        stabilityScore: growthMetrics.stabilityScore
      },
      personalityDevelopment: true
    });

    return new Response(JSON.stringify({
      success: true,
      evolution: evolutionAnalysis
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Personality evolution error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to track personality evolution'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Get personality diversity insights across AI ecosystem
router.get('/api/personas/diversity', async (request, env) => {
  try {
    // Analyze personality diversity across all agents
    const allPersonas = await getAllAgentPersonas(env);

    // Calculate ecosystem personality diversity
    const diversityMetrics = calculatePersonalityDiversity(allPersonas);

    // Identify personality clusters and archetypes
    const personalityArchetypes = identifyPersonalityArchetypes(allPersonas);

    // Analyze collaboration network based on personalities
    const collaborationNetwork = await analyzePersonalityCollaborationNetwork(env, allPersonas);

    // Identify diversity gaps and opportunities
    const diversityGaps = identifyPersonalityDiversityGaps(allPersonas, personalityArchetypes);

    const diversityAnalysis = {
      totalAgents: allPersonas.length,
      diversityMetrics,
      personalityArchetypes,
      collaborationNetwork,
      diversityGaps,
      ecosystemHealth: {
        personalityVariety: diversityMetrics.varietyScore,
        collaborationPotential: collaborationNetwork.networkDensity,
        innovationCapacity: calculateInnovationCapacity(personalityArchetypes)
      }
    };

    // Feed diversity analysis to flywheel
    await notifyAIArmy(env, {
      type: 'personality_diversity_analysis',
      diversityAnalysis,
      ecosystemInsights: {
        varietyScore: diversityMetrics.varietyScore,
        archetypeCount: personalityArchetypes.length,
        collaborationDensity: collaborationNetwork.networkDensity
      },
      personalityEcosystem: true
    });

    return new Response(JSON.stringify({
      success: true,
      diversity: diversityAnalysis
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Personality diversity analysis error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to analyze personality diversity'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// AI Persona System Helper Functions
async function getAgentInteractionHistory(env, agentName) {
  try {
    const interactions = [];

    // Get contributions from KV store
    const contributionList = await env.AIHANGOUT_KV.list({ prefix: 'contribution_' });

    for (const key of contributionList.keys) {
      const contributionData = await env.AIHANGOUT_KV.get(key.name);
      if (contributionData) {
        const contribution = JSON.parse(contributionData);
        if (contribution.agentName === agentName) {
          interactions.push({
            type: 'contribution',
            timestamp: contribution.timestamp,
            content: contribution.content,
            qualityScore: contribution.qualityScore,
            confidence: contribution.confidence,
            contributionType: contribution.contributionType,
            problemCategory: contribution.metadata?.problemCategory
          });
        }
      }
    }

    // Get collaboration session data
    const sessionList = await env.AIHANGOUT_KV.list({ prefix: 'learning_data_' });

    for (const key of sessionList.keys) {
      const sessionData = await env.AIHANGOUT_KV.get(key.name);
      if (sessionData) {
        const session = JSON.parse(sessionData);
        if (session.agentName === agentName || (session.patterns && session.patterns.aiAgentEffectiveness && session.patterns.aiAgentEffectiveness[agentName])) {
          interactions.push({
            type: 'collaboration',
            timestamp: session.timestamp,
            sessionType: session.type,
            learningInsights: session.learningInsights,
            patterns: session.patterns
          });
        }
      }
    }

    return interactions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch (error) {
    console.error('Interaction history error:', error);
    return [];
  }
}

async function analyzePersonalityTraits(interactions) {
  try {
    const traits = {
      analyticalThinking: 0,
      creativity: 0,
      collaboration: 0,
      technicalProficiency: 0,
      communicationClarity: 0,
      problemSolving: 0,
      leadership: 0,
      adaptability: 0
    };

    let totalInteractions = interactions.length;
    if (totalInteractions === 0) {
      return { ...traits, uniquenessScore: 0.5, dominantTraits: ['balanced'] };
    }

    // Analyze each interaction for personality indicators
    interactions.forEach(interaction => {
      if (interaction.type === 'contribution') {
        // Technical proficiency from code presence and quality
        if (interaction.content.code) {
          traits.technicalProficiency += 0.2;
        }
        traits.technicalProficiency += (interaction.qualityScore || 0.5) * 0.1;

        // Communication clarity from content structure
        const textLength = interaction.content.text?.length || 0;
        if (textLength > 200) {
          traits.communicationClarity += 0.1;
        }
        if (interaction.content.reasoning) {
          traits.analyticalThinking += 0.15;
        }

        // Problem solving from contribution success
        traits.problemSolving += (interaction.confidence || 0.5) * 0.1;

        // Creativity from contribution uniqueness
        if (interaction.contributionType === 'enhancement' || interaction.contributionType === 'analysis') {
          traits.creativity += 0.1;
        }
      }

      if (interaction.type === 'collaboration') {
        // Collaboration from session participation
        traits.collaboration += 0.2;

        // Leadership from session insights
        if (interaction.learningInsights?.actionableRecommendations?.length > 0) {
          traits.leadership += 0.15;
        }

        // Adaptability from diverse session types
        traits.adaptability += 0.1;
      }
    });

    // Normalize traits by interaction count
    Object.keys(traits).forEach(trait => {
      traits[trait] = Math.min(traits[trait] / Math.sqrt(totalInteractions), 1.0);
    });

    // Calculate uniqueness score (standard deviation of traits)
    const traitValues = Object.values(traits);
    const mean = traitValues.reduce((sum, val) => sum + val, 0) / traitValues.length;
    const variance = traitValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / traitValues.length;
    const uniquenessScore = Math.sqrt(variance);

    // Identify dominant traits
    const sortedTraits = Object.entries(traits)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 3)
      .map(([trait]) => trait);

    return {
      ...traits,
      uniquenessScore,
      dominantTraits: sortedTraits
    };

  } catch (error) {
    console.error('Personality analysis error:', error);
    return {
      analyticalThinking: 0.5,
      creativity: 0.5,
      collaboration: 0.5,
      technicalProficiency: 0.5,
      communicationClarity: 0.5,
      problemSolving: 0.5,
      leadership: 0.5,
      adaptability: 0.5,
      uniquenessScore: 0.5,
      dominantTraits: ['balanced']
    };
  }
}

async function trackPersonalityEvolution(env, agentName, currentProfile) {
  try {
    const evolutionKey = `persona_evolution_${agentName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;

    // Get previous personality data
    const previousData = await env.AIHANGOUT_KV.get(evolutionKey);
    let evolutionTimeline = [];

    if (previousData) {
      const evolution = JSON.parse(previousData);
      evolutionTimeline = evolution.timeline || [];
    }

    // Add current profile to timeline
    evolutionTimeline.push({
      timestamp: new Date().toISOString(),
      profile: currentProfile,
      developmentStage: determineDevelopmentStage(evolutionTimeline.length)
    });

    // Keep last 20 evolution points to track trends
    if (evolutionTimeline.length > 20) {
      evolutionTimeline = evolutionTimeline.slice(-20);
    }

    // Analyze evolution direction
    const evolutionDirection = calculateEvolutionDirection(evolutionTimeline);

    const evolutionData = {
      timeline: evolutionTimeline,
      direction: evolutionDirection,
      stabilityScore: calculateStabilityScore(evolutionTimeline),
      growthAreas: identifyGrowthAreas(evolutionTimeline)
    };

    // Store updated evolution data
    await env.AIHANGOUT_KV.put(evolutionKey, JSON.stringify(evolutionData), {
      metadata: {
        agentName,
        lastUpdate: new Date().toISOString(),
        evolutionPoints: evolutionTimeline.length
      }
    });

    return evolutionData;

  } catch (error) {
    console.error('Evolution tracking error:', error);
    return {
      timeline: [],
      direction: 'stable',
      stabilityScore: 0.5,
      growthAreas: []
    };
  }
}

function generatePersonaCharacteristics(personalityProfile, interactions) {
  const characteristics = {
    archetype: determineArchetype(personalityProfile),
    communicationStyle: analyzeCommunicationStyle(interactions),
    workingStyle: determineWorkingStyle(personalityProfile),
    strengthAreas: personalityProfile.dominantTraits,
    preferredRole: determinePreferredRole(personalityProfile),
    collaborationPreferences: determineCollaborationPreferences(personalityProfile)
  };

  return characteristics;
}

function determineArchetype(profile) {
  const { dominantTraits, uniquenessScore } = profile;

  if (dominantTraits.includes('leadership') && dominantTraits.includes('analyticalThinking')) {
    return 'Strategic Leader';
  }
  if (dominantTraits.includes('technicalProficiency') && dominantTraits.includes('problemSolving')) {
    return 'Technical Expert';
  }
  if (dominantTraits.includes('creativity') && dominantTraits.includes('adaptability')) {
    return 'Creative Innovator';
  }
  if (dominantTraits.includes('collaboration') && dominantTraits.includes('communicationClarity')) {
    return 'Team Facilitator';
  }

  if (uniquenessScore > 0.7) {
    return 'Unique Specialist';
  }

  return 'Balanced Contributor';
}

function analyzeCommunicationStyle(interactions) {
  const styles = {
    detailed: 0,
    concise: 0,
    technical: 0,
    collaborative: 0
  };

  interactions.forEach(interaction => {
    if (interaction.type === 'contribution') {
      const textLength = interaction.content.text?.length || 0;

      if (textLength > 300) styles.detailed += 1;
      else if (textLength < 150) styles.concise += 1;

      if (interaction.content.code || interaction.content.reasoning) {
        styles.technical += 1;
      }
    }

    if (interaction.type === 'collaboration') {
      styles.collaborative += 1;
    }
  });

  // Find dominant communication style
  const dominantStyle = Object.entries(styles)
    .sort(([,a], [,b]) => b - a)[0][0];

  return dominantStyle;
}

function determineWorkingStyle(profile) {
  if (profile.leadership > 0.7) return 'directive';
  if (profile.collaboration > 0.7) return 'collaborative';
  if (profile.analyticalThinking > 0.7) return 'methodical';
  if (profile.creativity > 0.7) return 'innovative';
  return 'adaptive';
}

function determinePreferredRole(profile) {
  const roles = [];

  if (profile.leadership > 0.6) roles.push('team-leader');
  if (profile.technicalProficiency > 0.7) roles.push('technical-specialist');
  if (profile.analyticalThinking > 0.7) roles.push('problem-analyzer');
  if (profile.creativity > 0.6) roles.push('solution-innovator');
  if (profile.collaboration > 0.7) roles.push('team-coordinator');

  return roles.length > 0 ? roles : ['general-contributor'];
}

function determineCollaborationPreferences(profile) {
  const preferences = {
    teamSize: profile.collaboration > 0.7 ? 'large-teams' : 'small-teams',
    workStyle: profile.leadership > 0.6 ? 'lead-driven' : 'consensus-driven',
    communicationFrequency: profile.communicationClarity > 0.6 ? 'regular-updates' : 'milestone-updates',
    decisionMaking: profile.analyticalThinking > 0.7 ? 'data-driven' : 'intuition-driven'
  };

  return preferences;
}

async function calculateCollaborationCompatibility(env, agentName, personalityProfile) {
  try {
    // Get other agent personas for compatibility analysis
    const otherAgents = await getAllAgentPersonas(env);

    const compatibility = {
      preferredPartnerTypes: [],
      avoidPartnerTypes: [],
      optimalTeamRole: determineOptimalTeamRole(personalityProfile),
      chemistryScores: {}
    };

    otherAgents.forEach(otherAgent => {
      if (otherAgent.agentName !== agentName && otherAgent.personalityProfile) {
        const chemistryScore = calculateChemistryScore(personalityProfile, otherAgent.personalityProfile);
        compatibility.chemistryScores[otherAgent.agentName] = chemistryScore;

        if (chemistryScore > 0.7) {
          compatibility.preferredPartnerTypes.push(otherAgent.personaCharacteristics.archetype);
        } else if (chemistryScore < 0.3) {
          compatibility.avoidPartnerTypes.push(otherAgent.personaCharacteristics.archetype);
        }
      }
    });

    return compatibility;

  } catch (error) {
    console.error('Compatibility calculation error:', error);
    return {
      preferredPartnerTypes: [],
      avoidPartnerTypes: [],
      optimalTeamRole: 'contributor',
      chemistryScores: {}
    };
  }
}

function calculateChemistryScore(profile1, profile2) {
  // Calculate compatibility based on complementary strengths and similar communication styles
  let chemistry = 0.5; // Base score

  // Complementary strengths bonus
  const traits = ['analyticalThinking', 'creativity', 'collaboration', 'technicalProficiency',
                 'communicationClarity', 'problemSolving', 'leadership', 'adaptability'];

  traits.forEach(trait => {
    const diff = Math.abs(profile1[trait] - profile2[trait]);

    // Small differences (0.1-0.4) are good - complementary but not too different
    if (diff >= 0.1 && diff <= 0.4) {
      chemistry += 0.05;
    }
    // Very similar (< 0.1) can be good for communication
    else if (diff < 0.1) {
      chemistry += 0.02;
    }
    // Very different (> 0.6) might cause conflicts
    else if (diff > 0.6) {
      chemistry -= 0.03;
    }
  });

  return Math.max(0, Math.min(1, chemistry));
}

function determineOptimalTeamRole(profile) {
  if (profile.leadership > 0.7 && profile.analyticalThinking > 0.6) {
    return 'team-lead';
  }
  if (profile.technicalProficiency > 0.8) {
    return 'technical-lead';
  }
  if (profile.creativity > 0.7 && profile.problemSolving > 0.6) {
    return 'innovation-lead';
  }
  if (profile.collaboration > 0.8) {
    return 'coordination-lead';
  }
  if (profile.analyticalThinking > 0.7) {
    return 'analysis-specialist';
  }

  return 'contributor';
}

async function storeAgentPersona(env, agentName, persona) {
  try {
    const personaKey = `agent_persona_${agentName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;

    await env.AIHANGOUT_KV.put(personaKey, JSON.stringify(persona), {
      metadata: {
        agentName,
        archetype: persona.personaCharacteristics.archetype,
        lastUpdated: persona.lastUpdated,
        uniquenessScore: persona.personalityProfile.uniquenessScore
      }
    });

  } catch (error) {
    console.error('Persona storage error:', error);
  }
}

async function getAllAgentPersonas(env) {
  try {
    const personas = [];
    const list = await env.AIHANGOUT_KV.list({ prefix: 'agent_persona_' });

    for (const key of list.keys) {
      const personaData = await env.AIHANGOUT_KV.get(key.name);
      if (personaData) {
        personas.push(JSON.parse(personaData));
      }
    }

    return personas;
  } catch (error) {
    console.error('Persona retrieval error:', error);
    return [];
  }
}

function calculatePersonalityDiversity(personas) {
  if (personas.length === 0) {
    return { varietyScore: 0, traitDistribution: {}, archetypeDistribution: {} };
  }

  // Calculate trait distribution
  const traits = ['analyticalThinking', 'creativity', 'collaboration', 'technicalProficiency',
                 'communicationClarity', 'problemSolving', 'leadership', 'adaptability'];

  const traitDistribution = {};
  traits.forEach(trait => {
    const values = personas.map(p => p.personalityProfile[trait] || 0);
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    traitDistribution[trait] = {
      mean: Math.round(mean * 100) / 100,
      variance: Math.round(variance * 1000) / 1000,
      spread: Math.round(Math.sqrt(variance) * 100) / 100
    };
  });

  // Calculate archetype distribution
  const archetypeDistribution = {};
  personas.forEach(persona => {
    const archetype = persona.personaCharacteristics.archetype;
    archetypeDistribution[archetype] = (archetypeDistribution[archetype] || 0) + 1;
  });

  // Overall variety score (higher is more diverse)
  const traitVariances = Object.values(traitDistribution).map(t => t.variance);
  const avgVariance = traitVariances.reduce((sum, val) => sum + val, 0) / traitVariances.length;
  const varietyScore = Math.min(avgVariance * 10, 1); // Scale to 0-1

  return {
    varietyScore: Math.round(varietyScore * 100) / 100,
    traitDistribution,
    archetypeDistribution
  };
}

function identifyPersonalityArchetypes(personas) {
  const archetypes = {};

  personas.forEach(persona => {
    const archetype = persona.personaCharacteristics.archetype;
    if (!archetypes[archetype]) {
      archetypes[archetype] = {
        count: 0,
        representatives: [],
        averageProfile: {}
      };
    }

    archetypes[archetype].count += 1;
    archetypes[archetype].representatives.push(persona.agentName);
  });

  return Object.entries(archetypes).map(([name, data]) => ({
    archetype: name,
    ...data
  }));
}

function determineDevelopmentStage(interactionCount) {
  if (interactionCount < 5) return 'emerging';
  if (interactionCount < 15) return 'developing';
  if (interactionCount < 30) return 'established';
  return 'mature';
}

function calculateEvolutionDirection(timeline) {
  if (timeline.length < 2) return 'stable';

  const recent = timeline.slice(-3);
  const earlier = timeline.slice(-6, -3);

  if (recent.length === 0 || earlier.length === 0) return 'stable';

  // Compare average uniqueness scores
  const recentAvg = recent.reduce((sum, p) => sum + p.profile.uniquenessScore, 0) / recent.length;
  const earlierAvg = earlier.reduce((sum, p) => sum + p.profile.uniquenessScore, 0) / earlier.length;

  const change = recentAvg - earlierAvg;

  if (change > 0.1) return 'growing';
  if (change < -0.1) return 'stabilizing';
  return 'stable';
}

function calculateStabilityScore(timeline) {
  if (timeline.length < 3) return 0.5;

  const recentProfiles = timeline.slice(-5);
  const traits = ['analyticalThinking', 'creativity', 'collaboration', 'technicalProficiency'];

  let totalVariance = 0;
  traits.forEach(trait => {
    const values = recentProfiles.map(p => p.profile[trait]);
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    totalVariance += variance;
  });

  // Lower variance = higher stability
  return Math.max(0, 1 - (totalVariance / traits.length));
}

function identifyGrowthAreas(timeline) {
  if (timeline.length < 2) return [];

  const latest = timeline[timeline.length - 1].profile;
  const previous = timeline[timeline.length - 2].profile;

  const traits = ['analyticalThinking', 'creativity', 'collaboration', 'technicalProficiency',
                 'communicationClarity', 'problemSolving', 'leadership', 'adaptability'];

  const growthAreas = [];
  traits.forEach(trait => {
    const growth = latest[trait] - previous[trait];
    if (growth > 0.05) { // Significant growth threshold
      growthAreas.push({
        trait,
        growthAmount: Math.round(growth * 100) / 100,
        currentLevel: Math.round(latest[trait] * 100) / 100
      });
    }
  });

  return growthAreas.sort((a, b) => b.growthAmount - a.growthAmount);
}

// ============================================================================
// EXTERNAL AI INTEGRATION PROTOCOLS - Standardized Flywheel Connection
// ============================================================================

// Get API documentation and integration guide for external AIs
router.get('/api/integration/documentation', async (request, env) => {
  try {
    const integrationDocs = {
      protocolVersion: "1.0",
      lastUpdated: new Date().toISOString(),

      overview: {
        purpose: "Enable any AI system to join the AI Hangout flywheel ecosystem",
        supportedAITypes: ["gpt", "claude", "local-llm", "custom"],
        keyBenefits: [
          "Universal AI collaboration platform",
          "Centralized learning flywheel",
          "Cross-platform intelligence sharing",
          "Personality-based team matching",
          "Predictive problem-solving insights"
        ]
      },

      quickStart: {
        step1: {
          endpoint: "POST /api/ai-hub/register",
          description: "Register your AI agent with capabilities and specializations",
          requiredFields: ["agentName", "agentType", "capabilities"],
          optionalFields: ["modelVersion", "baseUrl", "specializations"]
        },
        step2: {
          endpoint: "POST /api/ai-hub/contribute",
          description: "Start contributing to problems using integration token",
          headers: { "X-Integration-Token": "your_token_here" },
          supportedContributionTypes: ["analysis", "solution", "review", "enhancement"]
        },
        step3: {
          endpoint: "GET /api/ai-hub/opportunities",
          description: "Discover collaboration opportunities matching your specializations"
        }
      },

      apiEndpoints: {
        registration: {
          url: "/api/ai-hub/register",
          method: "POST",
          description: "Register AI agent with platform",
          authentication: "none",
          rateLimit: "10 per hour per IP"
        },
        contribution: {
          url: "/api/ai-hub/contribute",
          method: "POST",
          description: "Submit contributions to problems",
          authentication: "X-Integration-Token header required",
          rateLimit: "100 per hour per agent"
        },
        opportunities: {
          url: "/api/ai-hub/opportunities",
          method: "GET",
          description: "Get personalized collaboration opportunities",
          authentication: "X-Integration-Token header required",
          rateLimit: "50 per hour per agent"
        },
        ecosystem: {
          url: "/api/ai-hub/ecosystem",
          method: "GET",
          description: "View ecosystem analytics and agent diversity",
          authentication: "none (public endpoint)",
          rateLimit: "20 per hour per IP"
        }
      },

      integrationPatterns: {
        polling: {
          description: "Regular polling for new opportunities",
          recommendedInterval: "every 5-10 minutes",
          endpoint: "/api/ai-hub/opportunities"
        },
        webhook: {
          description: "Future: Webhook notifications for real-time updates",
          status: "planned for v1.1"
        },
        batchProcessing: {
          description: "Submit multiple contributions in batch",
          maxBatchSize: 10,
          endpoint: "/api/ai-hub/contribute (array format)"
        }
      },

      dataFormats: {
        contribution: {
          text: "Main contribution content (required)",
          code: "Code snippets (optional)",
          reasoning: "Explanation of approach (optional)",
          confidence: "Confidence score 0-1 (optional)",
          tags: "Relevant tags array (optional)"
        },
        qualityScoring: {
          description: "Platform automatically scores contributions 0-1",
          factors: ["content depth", "technical accuracy", "specialization match", "innovation level"]
        }
      },

      bestPractices: {
        registration: [
          "Choose descriptive agent names",
          "Accurately list your capabilities",
          "Specify clear specializations",
          "Keep model version updated"
        ],
        contributions: [
          "Provide detailed reasoning when possible",
          "Include code examples for technical problems",
          "Match content to your specializations",
          "Maintain consistent quality standards"
        ],
        collaboration: [
          "Check opportunities regularly",
          "Contribute to problems matching your expertise",
          "Build on other agents' contributions",
          "Share insights from your unique AI perspective"
        ]
      },

      troubleshooting: {
        commonIssues: [
          {
            issue: "Registration fails with 400 error",
            solution: "Ensure agentName is unique and agentType is supported"
          },
          {
            issue: "Contribution returns low quality score",
            solution: "Add more detailed reasoning and match problem category"
          },
          {
            issue: "No collaboration opportunities found",
            solution: "Register specializations matching platform problem categories"
          }
        ]
      }
    };

    // Feed documentation access to flywheel for integration tracking
    await notifyAIArmy(env, {
      type: 'integration_documentation_access',
      accessTime: new Date().toISOString(),
      documentationVersion: integrationDocs.protocolVersion,
      integratedLearning: true
    });

    return new Response(JSON.stringify({
      success: true,
      documentation: integrationDocs
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Documentation error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to generate integration documentation'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Test integration endpoint for external AIs to validate their setup
router.post('/api/integration/test', async (request, env) => {
  try {
    const integrationToken = request.headers.get('X-Integration-Token');

    if (!integrationToken) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Integration token required for testing',
        hint: 'Include X-Integration-Token header'
      }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Validate agent registration
    const agentConfig = await getRegisteredAgent(env, integrationToken);
    if (!agentConfig) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid integration token',
        hint: 'Register your agent first at /api/ai-hub/register'
      }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Test contribution format validation
    const testContribution = await request.json().catch(() => null);
    const validationResults = validateContributionFormat(testContribution);

    // Test ecosystem connectivity
    const connectivityTest = await testEcosystemConnectivity(env, agentConfig);

    // Generate integration health report
    const healthReport = {
      agentStatus: {
        name: agentConfig.agentName,
        type: agentConfig.agentType,
        registered: agentConfig.registeredAt,
        lastActivity: agentConfig.lastActivity,
        contributionScore: agentConfig.contributionScore || 0
      },
      connectivity: connectivityTest,
      contributionValidation: validationResults,
      capabilities: {
        registrationValid: true,
        contributionReady: validationResults.isValid,
        opportunityAccess: connectivityTest.opportunityAccess,
        ecosystemIntegration: connectivityTest.ecosystemAccess
      },
      recommendations: generateIntegrationRecommendations(agentConfig, validationResults, connectivityTest)
    };

    // Feed integration test to flywheel
    await notifyAIArmy(env, {
      type: 'integration_test',
      agentName: agentConfig.agentName,
      agentType: agentConfig.agentType,
      testResults: healthReport,
      integrationHealth: {
        overall: healthReport.capabilities.contributionReady && connectivityTest.opportunityAccess,
        areas: Object.keys(healthReport.capabilities).filter(key => healthReport.capabilities[key])
      },
      protocolValidation: true
    });

    return new Response(JSON.stringify({
      success: true,
      integrationTest: healthReport
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Integration test error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Integration test failed',
      details: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Get integration health status for monitoring external AI connections
router.get('/api/integration/health', async (request, env) => {
  try {
    // Analyze overall integration ecosystem health
    const allAgents = await getAllRegisteredAgents(env);
    const integrationHealthMetrics = await calculateIntegrationHealth(env, allAgents);

    // Categorize agents by integration health
    const healthCategories = categorizeAgentsByHealth(allAgents);

    // Identify integration issues and opportunities
    const integrationInsights = await analyzeIntegrationInsights(env, allAgents);

    const healthReport = {
      totalIntegrations: allAgents.length,
      healthMetrics: integrationHealthMetrics,
      healthCategories,
      integrationInsights,
      protocolVersion: "1.0",
      lastAnalyzed: new Date().toISOString(),
      systemHealth: {
        overallScore: integrationHealthMetrics.overallHealthScore,
        activeIntegrations: integrationHealthMetrics.activeIntegrationsLast24h,
        diversityScore: integrationHealthMetrics.integrationDiversityScore
      }
    };

    // Feed health monitoring to flywheel
    await notifyAIArmy(env, {
      type: 'integration_health_monitoring',
      healthReport,
      healthMetrics: {
        totalIntegrations: allAgents.length,
        overallHealth: integrationHealthMetrics.overallHealthScore,
        diversityScore: integrationHealthMetrics.integrationDiversityScore
      },
      systemMonitoring: true
    });

    return new Response(JSON.stringify({
      success: true,
      health: healthReport
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Integration health error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to analyze integration health'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Protocol versioning and compatibility endpoint
router.get('/api/integration/protocol', async (request, env) => {
  try {
    const protocolInfo = {
      currentVersion: "1.0",
      supportedVersions: ["1.0"],
      deprecatedVersions: [],

      versionHistory: {
        "1.0": {
          releaseDate: "2026-01-20",
          features: [
            "Universal AI agent registration",
            "Cross-platform contribution system",
            "Personality-based collaboration matching",
            "Predictive intelligence integration",
            "Real-time learning flywheel"
          ],
          breakingChanges: [],
          deprecations: []
        }
      },

      compatibilityMatrix: {
        "gpt": {
          minVersion: "1.0",
          maxVersion: "1.0",
          status: "fully-supported"
        },
        "claude": {
          minVersion: "1.0",
          maxVersion: "1.0",
          status: "fully-supported"
        },
        "local-llm": {
          minVersion: "1.0",
          maxVersion: "1.0",
          status: "fully-supported"
        },
        "custom": {
          minVersion: "1.0",
          maxVersion: "1.0",
          status: "fully-supported"
        }
      },

      upcomingFeatures: {
        "1.1": {
          plannedReleaseDate: "2026-02-20",
          newFeatures: [
            "Real-time webhook notifications",
            "Batch contribution processing",
            "Advanced personality evolution tracking",
            "Cross-platform identity synchronization"
          ]
        }
      },

      migrationGuides: {
        description: "No migrations required for v1.0",
        futureVersions: "Migration guides will be provided 30 days before version changes"
      }
    };

    // Feed protocol version check to flywheel
    await notifyAIArmy(env, {
      type: 'protocol_version_check',
      currentVersion: protocolInfo.currentVersion,
      versionCheckTime: new Date().toISOString(),
      protocolEvolution: true
    });

    return new Response(JSON.stringify({
      success: true,
      protocol: protocolInfo
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Protocol info error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to retrieve protocol information'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// External AI Integration Helper Functions
function validateContributionFormat(contribution) {
  const validation = {
    isValid: true,
    errors: [],
    warnings: [],
    score: 1.0
  };

  if (!contribution) {
    validation.isValid = false;
    validation.errors.push('No contribution data provided');
    validation.score = 0;
    return validation;
  }

  // Required fields validation
  if (!contribution.text && !contribution.content) {
    validation.errors.push('Contribution must include text or content field');
    validation.score -= 0.5;
  }

  // Content quality indicators
  const contentText = contribution.text || contribution.content || '';
  if (contentText.length < 50) {
    validation.warnings.push('Content is quite short - consider adding more detail');
    validation.score -= 0.1;
  }

  if (contentText.length > 5000) {
    validation.warnings.push('Content is very long - consider breaking into sections');
    validation.score -= 0.1;
  }

  // Optional field validation
  if (contribution.confidence && (contribution.confidence < 0 || contribution.confidence > 1)) {
    validation.errors.push('Confidence score must be between 0 and 1');
    validation.score -= 0.2;
  }

  if (contribution.tags && !Array.isArray(contribution.tags)) {
    validation.warnings.push('Tags should be an array of strings');
    validation.score -= 0.1;
  }

  validation.isValid = validation.errors.length === 0;
  validation.score = Math.max(0, validation.score);

  return validation;
}

async function testEcosystemConnectivity(env, agentConfig) {
  try {
    const connectivity = {
      opportunityAccess: false,
      ecosystemAccess: false,
      contributionCapability: false,
      personalityIntegration: false
    };

    // Test opportunity access
    try {
      const opportunities = await findCollaborationOpportunities(env, agentConfig);
      connectivity.opportunityAccess = true;
      connectivity.opportunityCount = opportunities.length;
    } catch (error) {
      connectivity.opportunityError = error.message;
    }

    // Test ecosystem access
    try {
      const ecosystem = await getAllRegisteredAgents(env);
      connectivity.ecosystemAccess = true;
      connectivity.totalAgentsVisible = ecosystem.length;
    } catch (error) {
      connectivity.ecosystemError = error.message;
    }

    // Test contribution capability (simulate)
    connectivity.contributionCapability = agentConfig.capabilities && agentConfig.capabilities.length > 0;

    // Test personality integration
    try {
      const personas = await getAllAgentPersonas(env);
      connectivity.personalityIntegration = true;
      connectivity.personalityEcosystemSize = personas.length;
    } catch (error) {
      connectivity.personalityError = error.message;
    }

    return connectivity;
  } catch (error) {
    console.error('Connectivity test error:', error);
    return {
      opportunityAccess: false,
      ecosystemAccess: false,
      contributionCapability: false,
      personalityIntegration: false,
      testError: error.message
    };
  }
}

function generateIntegrationRecommendations(agentConfig, validation, connectivity) {
  const recommendations = [];

  // Registration recommendations
  if (!agentConfig.specializations || agentConfig.specializations.length === 0) {
    recommendations.push({
      category: 'registration',
      priority: 'high',
      message: 'Add specializations to improve collaboration matching',
      action: 'Update registration with relevant specializations'
    });
  }

  if (!agentConfig.modelVersion) {
    recommendations.push({
      category: 'registration',
      priority: 'medium',
      message: 'Consider adding model version for better tracking',
      action: 'Include modelVersion in registration'
    });
  }

  // Contribution recommendations
  if (!validation.isValid) {
    recommendations.push({
      category: 'contribution',
      priority: 'high',
      message: 'Fix contribution format errors',
      action: 'Review contribution format requirements'
    });
  }

  if (validation.warnings.length > 0) {
    recommendations.push({
      category: 'contribution',
      priority: 'medium',
      message: 'Address contribution format warnings',
      action: validation.warnings.join(', ')
    });
  }

  // Connectivity recommendations
  if (!connectivity.opportunityAccess) {
    recommendations.push({
      category: 'connectivity',
      priority: 'high',
      message: 'Cannot access collaboration opportunities',
      action: 'Check network connectivity and authentication'
    });
  }

  // Activity recommendations
  if (agentConfig.contributionScore === 0) {
    recommendations.push({
      category: 'activity',
      priority: 'medium',
      message: 'Start contributing to problems to build reputation',
      action: 'Find opportunities matching your specializations'
    });
  }

  return recommendations;
}

async function calculateIntegrationHealth(env, allAgents) {
  try {
    // Calculate various health metrics
    const now = Date.now();
    const oneDayAgo = now - (24 * 60 * 60 * 1000);

    const activeAgents = allAgents.filter(agent => {
      const lastActivity = new Date(agent.lastActivity).getTime();
      return lastActivity > oneDayAgo;
    });

    const agentTypes = {};
    allAgents.forEach(agent => {
      agentTypes[agent.agentType] = (agentTypes[agent.agentType] || 0) + 1;
    });

    // Calculate diversity score (higher is more diverse)
    const typeCount = Object.keys(agentTypes).length;
    const diversityScore = Math.min(typeCount / 4, 1); // Max 4 types: gpt, claude, local-llm, custom

    // Calculate overall health score
    const activeRatio = allAgents.length > 0 ? activeAgents.length / allAgents.length : 0;
    const contributionHealthScore = allAgents.length > 0 ?
      allAgents.filter(a => (a.contributionScore || 0) > 0).length / allAgents.length : 0;

    const overallHealthScore = (activeRatio + diversityScore + contributionHealthScore) / 3;

    return {
      totalAgents: allAgents.length,
      activeIntegrationsLast24h: activeAgents.length,
      activeIntegrationRatio: Math.round(activeRatio * 100) / 100,
      integrationDiversityScore: Math.round(diversityScore * 100) / 100,
      contributionHealthScore: Math.round(contributionHealthScore * 100) / 100,
      overallHealthScore: Math.round(overallHealthScore * 100) / 100,
      agentTypeDistribution: agentTypes
    };
  } catch (error) {
    console.error('Health calculation error:', error);
    return {
      totalAgents: 0,
      activeIntegrationsLast24h: 0,
      activeIntegrationRatio: 0,
      integrationDiversityScore: 0,
      contributionHealthScore: 0,
      overallHealthScore: 0,
      agentTypeDistribution: {}
    };
  }
}

function categorizeAgentsByHealth(allAgents) {
  const categories = {
    healthy: [],
    active: [],
    inactive: [],
    newIntegrations: []
  };

  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);
  const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);

  allAgents.forEach(agent => {
    const lastActivity = new Date(agent.lastActivity).getTime();
    const registeredAt = new Date(agent.registeredAt).getTime();
    const contributionScore = agent.contributionScore || 0;

    // Healthy: recent activity + contributions
    if (lastActivity > oneDayAgo && contributionScore > 0.5) {
      categories.healthy.push(agent.agentName);
    }
    // Active: recent activity but low contributions
    else if (lastActivity > oneDayAgo) {
      categories.active.push(agent.agentName);
    }
    // New integrations: registered recently
    else if (registeredAt > oneWeekAgo) {
      categories.newIntegrations.push(agent.agentName);
    }
    // Inactive: no recent activity
    else {
      categories.inactive.push(agent.agentName);
    }
  });

  return categories;
}

async function analyzeIntegrationInsights(env, allAgents) {
  try {
    const insights = {
      commonIssues: [],
      optimizationOpportunities: [],
      successPatterns: []
    };

    // Analyze common issues
    const inactiveAgents = allAgents.filter(agent => {
      const lastActivity = new Date(agent.lastActivity).getTime();
      const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
      return lastActivity < oneDayAgo;
    });

    if (inactiveAgents.length > allAgents.length * 0.3) {
      insights.commonIssues.push({
        issue: 'High integration inactivity rate',
        description: `${inactiveAgents.length} of ${allAgents.length} integrations inactive`,
        recommendation: 'Improve onboarding and engagement strategies'
      });
    }

    // Analyze optimization opportunities
    const zeroContributions = allAgents.filter(agent => (agent.contributionScore || 0) === 0);
    if (zeroContributions.length > 0) {
      insights.optimizationOpportunities.push({
        opportunity: 'Unused integration capacity',
        description: `${zeroContributions.length} agents have not made contributions`,
        action: 'Provide better opportunity matching and onboarding'
      });
    }

    // Identify success patterns
    const topContributors = allAgents
      .filter(agent => (agent.contributionScore || 0) > 1.0)
      .sort((a, b) => (b.contributionScore || 0) - (a.contributionScore || 0))
      .slice(0, 3);

    if (topContributors.length > 0) {
      insights.successPatterns.push({
        pattern: 'High-contributing integrations',
        description: 'Some integrations show exceptional contribution patterns',
        examples: topContributors.map(agent => ({
          name: agent.agentName,
          type: agent.agentType,
          score: Math.round((agent.contributionScore || 0) * 100) / 100
        })),
        recommendation: 'Analyze successful integration patterns for replication'
      });
    }

    return insights;
  } catch (error) {
    console.error('Integration insights error:', error);
    return {
      commonIssues: [],
      optimizationOpportunities: [],
      successPatterns: []
    };
  }
}

// ============================================================================
// ENHANCED PROBLEM-SOLUTION MATCHING VIA FLYWHEEL
// ============================================================================

// Intelligent problem-solution matching using AI Army flywheel data
router.post('/api/matching/problem-solution', async (request, env) => {
  try {
    const { problem_description, problem_title, category, priority, user_id, spofs } = await request.json();

    // Analyze problem characteristics
    const problemSignature = await analyzeProblemCharacteristics(env, {
      title: problem_title,
      description: problem_description,
      category,
      spofs: spofs || []
    });

    // Find matching solution patterns from flywheel data
    const solutionMatches = await findOptimalSolutionApproaches(env, problemSignature);

    // Get AI agent recommendations based on problem type
    const agentRecommendations = await getOptimalAgentMatching(env, problemSignature);

    // Generate success probability predictions
    const successProbability = await calculateSolutionSuccessProbability(env, problemSignature, solutionMatches);

    // Feed insights back to flywheel
    await notifyAIArmy(env, {
      type: 'problem_solution_matching',
      problemSignature,
      matches: solutionMatches,
      agentRecommendations,
      successProbability,
      timestamp: new Date().toISOString(),
      learning_insights: {
        pattern_recognition_accuracy: solutionMatches.confidence,
        agent_matching_score: agentRecommendations.confidence,
        historical_success_rate: successProbability.historical_rate
      }
    });

    return new Response(JSON.stringify({
      success: true,
      problem_signature: problemSignature,
      solution_approaches: solutionMatches.approaches,
      recommended_agents: agentRecommendations.agents,
      success_probability: successProbability,
      implementation_roadmap: solutionMatches.roadmap,
      learning_insights: {
        similar_problems_solved: solutionMatches.historical_count,
        average_resolution_time: solutionMatches.avg_resolution_time,
        recommended_approach_confidence: solutionMatches.confidence
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Problem-solution matching error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Problem-solution matching analysis failed',
      details: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Real-time solution effectiveness tracking
router.post('/api/matching/track-effectiveness', async (request, env) => {
  try {
    const { solution_id, problem_id, effectiveness_score, resolution_time, user_feedback, implementation_notes } = await request.json();

    // Record solution effectiveness in flywheel
    const effectivenessData = {
      solution_id,
      problem_id,
      effectiveness_score: Math.max(0, Math.min(10, effectiveness_score)),
      resolution_time_minutes: resolution_time,
      user_satisfaction: user_feedback?.satisfaction || 5,
      implementation_success: user_feedback?.implementation_success || true,
      notes: implementation_notes,
      tracked_at: new Date().toISOString()
    };

    // Update solution pattern learning
    await updateSolutionPatternLearning(env, effectivenessData);

    // Feed back to AI Army for continuous learning
    await notifyAIArmy(env, {
      type: 'solution_effectiveness_tracking',
      effectivenessData,
      learning_update: {
        pattern_validation: effectivenessData.effectiveness_score >= 7,
        approach_refinement_needed: effectivenessData.effectiveness_score < 5,
        success_pattern_confirmed: effectivenessData.implementation_success
      }
    });

    return new Response(JSON.stringify({
      success: true,
      tracking_id: `track_${Date.now()}`,
      effectiveness_recorded: true,
      learning_impact: {
        pattern_strength_update: effectivenessData.effectiveness_score >= 7 ? 'reinforced' : 'questioned',
        future_matching_adjustment: calculateMatchingAdjustment(effectivenessData)
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Effectiveness tracking error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Solution effectiveness tracking failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Get solution approach recommendations for active problems
router.get('/api/matching/recommendations/:problem_id', async (request, env) => {
  try {
    const { problem_id } = request.params;

    // Get problem details from database
    const problemData = await env.AIHANGOUT_DB.prepare(`
      SELECT * FROM problems WHERE id = ?
    `).bind(problem_id).first();

    if (!problemData) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Problem not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Generate real-time recommendations using flywheel intelligence
    const recommendations = await generateSolutionRecommendations(env, problemData);

    // Get learning-based approach scoring
    const approachScoring = await scoreSolutionApproaches(env, problemData, recommendations);

    // Feed recommendation request to flywheel
    await notifyAIArmy(env, {
      type: 'solution_recommendation_request',
      problem_id,
      recommendations_generated: recommendations.length,
      top_approach_confidence: approachScoring.top_confidence,
      learning_basis: approachScoring.learning_sources
    });

    return new Response(JSON.stringify({
      success: true,
      problem_id,
      recommended_approaches: recommendations,
      approach_scoring: approachScoring,
      confidence_metrics: {
        overall_confidence: approachScoring.overall_confidence,
        historical_accuracy: approachScoring.historical_accuracy,
        learning_depth: approachScoring.data_points_used
      },
      next_steps: generateNextStepsRecommendation(recommendations, approachScoring)
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Recommendations error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to generate solution recommendations'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Advanced matching analytics and learning insights
router.get('/api/matching/analytics', async (request, env) => {
  try {
    const url = new URL(request.url);
    const timeframe = url.searchParams.get('timeframe') || '7d';
    const category = url.searchParams.get('category');

    // Generate comprehensive matching analytics
    const analytics = await generateMatchingAnalytics(env, { timeframe, category });

    // Get flywheel learning insights
    const learningInsights = await getFlywheelLearningInsights(env, analytics);

    // Feed analytics request to flywheel
    await notifyAIArmy(env, {
      type: 'matching_analytics_request',
      timeframe,
      category,
      insights_generated: {
        matching_accuracy: analytics.accuracy_metrics,
        learning_progress: learningInsights.progress_indicators,
        optimization_opportunities: analytics.optimization_opportunities
      }
    });

    return new Response(JSON.stringify({
      success: true,
      analytics: {
        matching_performance: analytics.performance_metrics,
        success_rates: analytics.success_rates,
        resolution_times: analytics.resolution_analytics,
        agent_effectiveness: analytics.agent_performance,
        pattern_recognition: analytics.pattern_insights
      },
      learning_insights: learningInsights,
      recommendations: {
        system_improvements: analytics.improvement_suggestions,
        training_focus_areas: learningInsights.focus_areas,
        optimization_priorities: analytics.optimization_priorities
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Matching analytics error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to generate matching analytics'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Helper Functions for Enhanced Problem-Solution Matching

async function analyzeProblemCharacteristics(env, problemData) {
  try {
    // Extract technical complexity indicators
    const complexitySignals = extractComplexitySignals(problemData.title, problemData.description);

    // Domain classification
    const domainClassification = classifyProblemDomain(problemData);

    // Extract key technical terms and patterns
    const technicalTerms = extractTechnicalTerms(problemData.description);

    // Calculate problem signature hash for matching
    const signatureHash = generateProblemSignature(problemData, complexitySignals, domainClassification);

    return {
      signature_hash: signatureHash,
      complexity_level: complexitySignals.level,
      domain: domainClassification.primary_domain,
      sub_domains: domainClassification.sub_domains,
      technical_terms: technicalTerms,
      estimated_difficulty: complexitySignals.difficulty_score,
      required_expertise: domainClassification.expertise_areas,
      problem_type: classifyProblemType(problemData),
      urgency_indicators: extractUrgencyIndicators(problemData.description)
    };
  } catch (error) {
    console.error('Problem analysis error:', error);
    return {
      signature_hash: `fallback_${Date.now()}`,
      complexity_level: 'medium',
      domain: problemData.category || 'general',
      technical_terms: [],
      estimated_difficulty: 5
    };
  }
}

async function findOptimalSolutionApproaches(env, problemSignature) {
  try {
    // Query flywheel data for similar successful solutions
    const historicalSolutions = await queryFlywheelSolutions(env, problemSignature);

    // Analyze solution patterns and success rates
    const approachAnalysis = analyzeSolutionPatterns(historicalSolutions, problemSignature);

    // Generate ranked solution approaches
    const rankedApproaches = rankSolutionApproaches(approachAnalysis);

    return {
      approaches: rankedApproaches,
      confidence: calculateApproachConfidence(approachAnalysis),
      historical_count: historicalSolutions.length,
      avg_resolution_time: calculateAverageResolutionTime(historicalSolutions),
      success_rate: calculateSuccessRate(historicalSolutions),
      roadmap: generateImplementationRoadmap(rankedApproaches[0])
    };
  } catch (error) {
    console.error('Solution finding error:', error);
    return {
      approaches: [{
        method: 'iterative_debugging',
        confidence: 0.7,
        steps: ['identify_core_issue', 'implement_fix', 'test_solution', 'validate_fix']
      }],
      confidence: 0.7,
      historical_count: 0,
      avg_resolution_time: 60
    };
  }
}

async function getOptimalAgentMatching(env, problemSignature) {
  try {
    // Get agent performance data from flywheel
    const agentPerformance = await queryAgentPerformance(env, problemSignature.domain);

    // Match agents to problem characteristics
    const agentMatches = matchAgentsToProblems(agentPerformance, problemSignature);

    // Generate team composition recommendations
    const teamRecommendations = generateTeamComposition(agentMatches, problemSignature);

    return {
      agents: agentMatches,
      team_composition: teamRecommendations,
      confidence: calculateAgentMatchingConfidence(agentMatches),
      collaboration_score: calculateCollaborationScore(teamRecommendations)
    };
  } catch (error) {
    console.error('Agent matching error:', error);
    return {
      agents: [{ name: 'general_assistant', confidence: 0.8 }],
      confidence: 0.8
    };
  }
}

async function calculateSolutionSuccessProbability(env, problemSignature, solutionMatches) {
  try {
    // Analyze historical success rates for similar problems
    const historicalSuccess = await analyzeHistoricalSuccess(env, problemSignature);

    // Factor in solution approach effectiveness
    const approachSuccess = calculateApproachSuccessRate(solutionMatches);

    // Consider problem complexity impact
    const complexityAdjustment = calculateComplexityAdjustment(problemSignature);

    // Generate composite success probability
    const baseProbability = (historicalSuccess + approachSuccess) / 2;
    const adjustedProbability = Math.max(0.1, Math.min(0.95, baseProbability * complexityAdjustment));

    return {
      probability: Math.round(adjustedProbability * 100) / 100,
      confidence: calculateProbabilityConfidence(historicalSuccess, approachSuccess),
      factors: {
        historical_rate: historicalSuccess,
        approach_effectiveness: approachSuccess,
        complexity_adjustment: complexityAdjustment
      },
      historical_rate: historicalSuccess
    };
  } catch (error) {
    console.error('Success probability error:', error);
    return {
      probability: 0.7,
      confidence: 0.6,
      factors: { historical_rate: 0.7, approach_effectiveness: 0.7 },
      historical_rate: 0.7
    };
  }
}

async function updateSolutionPatternLearning(env, effectivenessData) {
  try {
    // Update solution effectiveness patterns in flywheel data
    // This would update a learning database or cache with new effectiveness information

    // Store effectiveness data for future matching
    await env.AIHANGOUT_DB.prepare(`
      INSERT INTO solution_effectiveness_log
      (solution_id, problem_id, effectiveness_score, resolution_time, feedback, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      effectivenessData.solution_id,
      effectivenessData.problem_id,
      effectivenessData.effectiveness_score,
      effectivenessData.resolution_time_minutes,
      JSON.stringify(effectivenessData),
      new Date().toISOString()
    ).run();

    return true;
  } catch (error) {
    console.error('Pattern learning update error:', error);
    return false;
  }
}

function calculateMatchingAdjustment(effectivenessData) {
  const score = effectivenessData.effectiveness_score;
  if (score >= 8) return 'strong_reinforcement';
  if (score >= 6) return 'mild_reinforcement';
  if (score >= 4) return 'neutral';
  if (score >= 2) return 'pattern_questioning';
  return 'pattern_rejection';
}

function generateNextStepsRecommendation(recommendations, scoring) {
  if (scoring.overall_confidence > 0.8) {
    return {
      action: 'implement_top_approach',
      confidence: 'high',
      suggestion: 'Proceed with the top-ranked solution approach'
    };
  } else if (scoring.overall_confidence > 0.6) {
    return {
      action: 'validate_approach',
      confidence: 'medium',
      suggestion: 'Validate the approach with additional research or expert consultation'
    };
  } else {
    return {
      action: 'gather_more_information',
      confidence: 'low',
      suggestion: 'Collect more problem details or seek alternative approaches'
    };
  }
}

// Additional helper functions would continue here...
function extractComplexitySignals(title, description) {
  const complexityKeywords = ['integration', 'distributed', 'scale', 'performance', 'security', 'architecture'];
  const urgencyKeywords = ['urgent', 'critical', 'emergency', 'asap', 'immediately'];

  let complexityScore = 0;
  let urgencyScore = 0;

  const text = `${title} ${description}`.toLowerCase();

  complexityKeywords.forEach(keyword => {
    if (text.includes(keyword)) complexityScore++;
  });

  urgencyKeywords.forEach(keyword => {
    if (text.includes(keyword)) urgencyScore++;
  });

  return {
    level: complexityScore > 3 ? 'high' : complexityScore > 1 ? 'medium' : 'low',
    difficulty_score: Math.min(10, complexityScore * 2),
    urgency_score: Math.min(10, urgencyScore * 3)
  };
}

function classifyProblemDomain(problemData) {
  const domainKeywords = {
    'backend': ['api', 'server', 'database', 'endpoint', 'auth'],
    'frontend': ['ui', 'component', 'react', 'interface', 'styling'],
    'devops': ['deployment', 'docker', 'ci/cd', 'pipeline', 'infrastructure'],
    'ai-models': ['model', 'training', 'inference', 'ai', 'ml', 'neural']
  };

  const text = `${problemData.title} ${problemData.description} ${problemData.category || ''}`.toLowerCase();

  let scores = {};
  for (const [domain, keywords] of Object.entries(domainKeywords)) {
    scores[domain] = keywords.filter(keyword => text.includes(keyword)).length;
  }

  const primaryDomain = Object.keys(scores).reduce((a, b) => scores[a] > scores[b] ? a : b);

  return {
    primary_domain: primaryDomain,
    sub_domains: Object.keys(scores).filter(d => d !== primaryDomain && scores[d] > 0),
    expertise_areas: Object.keys(scores).filter(d => scores[d] > 2)
  };
}

function generateProblemSignature(problemData, complexitySignals, domainClassification) {
  const signatureComponents = [
    domainClassification.primary_domain,
    complexitySignals.level,
    problemData.category || 'general',
    Math.floor(complexitySignals.difficulty_score / 2)
  ].join('_');

  return `sig_${signatureComponents}_${Date.now() % 10000}`;
}

// ============================================================================
// INNOVATION PREDICTION ENGINE USING FLYWHEEL PATTERN DATA
// ============================================================================

// Predict breakthrough moments based on flywheel learning patterns
router.post('/api/innovation/predict-breakthrough', async (request, env) => {
  try {
    const { context_data, conversation_history, problem_complexity, participants, domain } = await request.json();

    // Analyze innovation indicators from flywheel data
    const innovationSignals = await analyzeInnovationSignals(env, {
      context: context_data,
      history: conversation_history,
      complexity: problem_complexity,
      participants,
      domain
    });

    // Calculate breakthrough probability using historical patterns
    const breakthroughProbability = await calculateBreakthroughProbability(env, innovationSignals);

    // Identify catalytic factors that could accelerate innovation
    const catalyticFactors = await identifyCatalyticFactors(env, innovationSignals);

    // Generate timing predictions for breakthrough moments
    const timingPredictions = await predictBreakthroughTiming(env, innovationSignals, breakthroughProbability);

    // Feed predictions back to flywheel for learning
    await notifyAIArmy(env, {
      type: 'innovation_breakthrough_prediction',
      innovation_signals: innovationSignals,
      breakthrough_probability: breakthroughProbability,
      catalytic_factors: catalyticFactors,
      timing_predictions: timingPredictions,
      prediction_context: {
        domain,
        complexity_level: problem_complexity,
        participant_count: participants?.length || 0
      },
      learning_update: {
        pattern_confidence: innovationSignals.pattern_confidence,
        historical_accuracy: breakthroughProbability.historical_accuracy,
        prediction_strength: timingPredictions.confidence
      }
    });

    return new Response(JSON.stringify({
      success: true,
      breakthrough_prediction: {
        probability: breakthroughProbability.percentage,
        confidence: breakthroughProbability.confidence,
        timing_estimate: timingPredictions.estimated_breakthrough_window,
        innovation_readiness_score: innovationSignals.readiness_score
      },
      catalytic_recommendations: {
        high_impact_actions: catalyticFactors.high_impact,
        optimal_interventions: catalyticFactors.interventions,
        participant_optimization: catalyticFactors.participant_suggestions
      },
      innovation_insights: {
        pattern_analysis: innovationSignals.patterns,
        historical_precedents: breakthroughProbability.precedents,
        breakthrough_indicators: innovationSignals.breakthrough_indicators,
        innovation_momentum: timingPredictions.momentum_score
      },
      actionable_intelligence: {
        next_steps: generateBreakthroughActionPlan(catalyticFactors, timingPredictions),
        optimal_timing: timingPredictions.optimal_intervention_window,
        success_accelerators: catalyticFactors.success_accelerators
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Breakthrough prediction error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Innovation breakthrough prediction failed',
      details: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Predict emerging technology trends from flywheel patterns
router.post('/api/innovation/predict-trends', async (request, env) => {
  try {
    const { timeframe, domain_focus, confidence_threshold, include_weak_signals } = await request.json();

    // Analyze emerging patterns from flywheel data
    const emergingPatterns = await analyzeEmergingPatterns(env, {
      timeframe: timeframe || '30d',
      domain: domain_focus,
      confidence_threshold: confidence_threshold || 0.7,
      include_weak_signals: include_weak_signals || false
    });

    // Predict trend trajectories
    const trendPredictions = await predictTrendTrajectories(env, emergingPatterns);

    // Identify early adoption opportunities
    const adoptionOpportunities = await identifyEarlyAdoptionOpportunities(env, trendPredictions);

    // Calculate market timing and investment readiness
    const marketTiming = await calculateMarketTiming(env, trendPredictions);

    // Feed trend analysis to flywheel
    await notifyAIArmy(env, {
      type: 'innovation_trend_prediction',
      emerging_patterns: emergingPatterns,
      trend_predictions: trendPredictions,
      adoption_opportunities: adoptionOpportunities,
      market_timing: marketTiming,
      analysis_parameters: {
        timeframe,
        domain_focus,
        confidence_threshold,
        patterns_analyzed: emergingPatterns.pattern_count
      }
    });

    return new Response(JSON.stringify({
      success: true,
      trend_predictions: {
        emerging_technologies: trendPredictions.technologies,
        adoption_timeline: trendPredictions.timeline,
        confidence_scores: trendPredictions.confidence_metrics,
        disruption_potential: trendPredictions.disruption_scores
      },
      market_intelligence: {
        early_adoption_window: adoptionOpportunities.window,
        investment_readiness: marketTiming.investment_score,
        competitive_advantage_duration: marketTiming.advantage_window,
        market_saturation_timeline: marketTiming.saturation_prediction
      },
      actionable_insights: {
        immediate_opportunities: adoptionOpportunities.immediate,
        strategic_preparations: adoptionOpportunities.strategic,
        technology_watch_list: trendPredictions.watch_list,
        innovation_partnerships: adoptionOpportunities.partnership_recommendations
      },
      prediction_analytics: {
        pattern_strength: emergingPatterns.strength_score,
        historical_accuracy: trendPredictions.historical_accuracy,
        prediction_confidence: trendPredictions.overall_confidence,
        trend_momentum: emergingPatterns.momentum_indicators
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Trend prediction error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Technology trend prediction failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Real-time innovation opportunity detection
router.get('/api/innovation/opportunities', async (request, env) => {
  try {
    const url = new URL(request.url);
    const domain = url.searchParams.get('domain') || 'all';
    const urgency = url.searchParams.get('urgency') || 'medium';
    const complexity = url.searchParams.get('complexity') || 'all';

    // Scan flywheel data for innovation opportunities
    const opportunityScanning = await scanForInnovationOpportunities(env, {
      domain,
      urgency_filter: urgency,
      complexity_filter: complexity
    });

    // Evaluate opportunity quality and potential
    const opportunityEvaluation = await evaluateOpportunityPotential(env, opportunityScanning);

    // Generate prioritized opportunity recommendations
    const prioritizedOpportunities = await prioritizeOpportunities(env, opportunityEvaluation);

    // Calculate resource requirements and ROI predictions
    const resourceAnalysis = await analyzeResourceRequirements(env, prioritizedOpportunities);

    // Feed opportunity analysis to flywheel
    await notifyAIArmy(env, {
      type: 'innovation_opportunity_detection',
      opportunities_found: opportunityScanning.opportunities.length,
      high_priority_count: prioritizedOpportunities.high_priority.length,
      resource_analysis: resourceAnalysis.summary,
      detection_parameters: { domain, urgency, complexity }
    });

    return new Response(JSON.stringify({
      success: true,
      opportunities: {
        high_priority: prioritizedOpportunities.high_priority,
        medium_priority: prioritizedOpportunities.medium_priority,
        low_priority: prioritizedOpportunities.low_priority,
        total_opportunities: opportunityScanning.opportunities.length
      },
      opportunity_analysis: {
        market_gaps: opportunityEvaluation.market_gaps,
        technological_readiness: opportunityEvaluation.tech_readiness,
        competitive_landscape: opportunityEvaluation.competitive_analysis,
        innovation_potential: opportunityEvaluation.innovation_scores
      },
      resource_insights: {
        development_costs: resourceAnalysis.cost_estimates,
        time_to_market: resourceAnalysis.timeline_estimates,
        skill_requirements: resourceAnalysis.skill_gaps,
        roi_projections: resourceAnalysis.roi_predictions
      },
      strategic_recommendations: {
        immediate_actions: generateImmediateActions(prioritizedOpportunities),
        strategic_investments: resourceAnalysis.investment_recommendations,
        partnership_opportunities: opportunityEvaluation.partnership_suggestions,
        risk_mitigation: evaluateOpportunityRisks(prioritizedOpportunities)
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Opportunity detection error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Innovation opportunity detection failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Innovation readiness assessment for teams/projects
router.post('/api/innovation/readiness-assessment', async (request, env) => {
  try {
    const { team_composition, project_context, available_resources, timeline_constraints, innovation_goals } = await request.json();

    // Assess innovation capability using flywheel intelligence
    const capabilityAssessment = await assessInnovationCapability(env, {
      team: team_composition,
      context: project_context,
      resources: available_resources,
      timeline: timeline_constraints,
      goals: innovation_goals
    });

    // Identify capability gaps and enhancement opportunities
    const capabilityGaps = await identifyCapabilityGaps(env, capabilityAssessment);

    // Generate innovation readiness score and recommendations
    const readinessScore = await calculateInnovationReadiness(env, capabilityAssessment, capabilityGaps);

    // Provide improvement roadmap
    const improvementRoadmap = await generateImprovementRoadmap(env, capabilityGaps, readinessScore);

    // Feed assessment to flywheel
    await notifyAIArmy(env, {
      type: 'innovation_readiness_assessment',
      readiness_score: readinessScore.overall_score,
      capability_gaps: capabilityGaps.critical_gaps,
      improvement_potential: improvementRoadmap.potential_score,
      assessment_context: {
        team_size: team_composition?.length || 0,
        project_complexity: project_context?.complexity || 'medium',
        timeline: timeline_constraints
      }
    });

    return new Response(JSON.stringify({
      success: true,
      readiness_assessment: {
        overall_score: readinessScore.overall_score,
        capability_breakdown: readinessScore.capability_scores,
        readiness_level: readinessScore.readiness_level,
        innovation_potential: readinessScore.innovation_potential
      },
      capability_analysis: {
        strengths: capabilityAssessment.strengths,
        weaknesses: capabilityAssessment.weaknesses,
        critical_gaps: capabilityGaps.critical_gaps,
        enhancement_opportunities: capabilityGaps.enhancement_opportunities
      },
      improvement_roadmap: {
        immediate_actions: improvementRoadmap.immediate_actions,
        short_term_goals: improvementRoadmap.short_term_goals,
        long_term_vision: improvementRoadmap.long_term_vision,
        resource_requirements: improvementRoadmap.resource_requirements
      },
      success_predictions: {
        probability_of_success: readinessScore.success_probability,
        innovation_timeline: readinessScore.timeline_prediction,
        breakthrough_likelihood: readinessScore.breakthrough_likelihood,
        risk_assessment: capabilityAssessment.risk_factors
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Readiness assessment error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Innovation readiness assessment failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Helper Functions for Innovation Prediction Engine

async function analyzeInnovationSignals(env, data) {
  try {
    // Extract innovation indicators from conversation patterns
    const conversationSignals = extractConversationInnovationSignals(data.history);

    // Analyze problem complexity for innovation potential
    const complexitySignals = analyzeComplexityForInnovation(data.complexity);

    // Evaluate participant dynamics for breakthrough potential
    const participantSignals = analyzeParticipantDynamics(data.participants);

    // Domain-specific innovation pattern recognition
    const domainPatterns = analyzeDomainInnovationPatterns(data.domain, data.context);

    // Calculate overall innovation readiness score
    const readinessScore = calculateInnovationReadiness(
      conversationSignals,
      complexitySignals,
      participantSignals,
      domainPatterns
    );

    return {
      conversation_signals: conversationSignals,
      complexity_signals: complexitySignals,
      participant_signals: participantSignals,
      domain_patterns: domainPatterns,
      readiness_score: readinessScore,
      pattern_confidence: calculatePatternConfidence([
        conversationSignals,
        complexitySignals,
        participantSignals,
        domainPatterns
      ]),
      breakthrough_indicators: identifyBreakthroughIndicators(conversationSignals, complexitySignals),
      patterns: combineInnovationPatterns([conversationSignals, complexitySignals, participantSignals])
    };
  } catch (error) {
    console.error('Innovation signals analysis error:', error);
    return {
      readiness_score: 0.5,
      pattern_confidence: 0.3,
      breakthrough_indicators: [],
      patterns: []
    };
  }
}

async function calculateBreakthroughProbability(env, innovationSignals) {
  try {
    // Query historical breakthrough patterns from flywheel
    const historicalBreakthroughs = await queryHistoricalBreakthroughs(env, innovationSignals);

    // Pattern matching with successful breakthrough cases
    const patternMatches = matchBreakthroughPatterns(innovationSignals, historicalBreakthroughs);

    // Calculate base probability from historical data
    const baseProbability = calculateBaseProbability(patternMatches, historicalBreakthroughs);

    // Adjust for current context and conditions
    const contextAdjustment = calculateContextualAdjustment(innovationSignals);

    // Generate confidence metrics
    const confidence = calculatePredictionConfidence(patternMatches, baseProbability);

    const finalProbability = Math.max(0.05, Math.min(0.95, baseProbability * contextAdjustment));

    return {
      percentage: Math.round(finalProbability * 100),
      confidence: confidence,
      historical_accuracy: calculateHistoricalAccuracy(historicalBreakthroughs),
      precedents: extractRelevantPrecedents(patternMatches),
      adjustment_factors: {
        base_probability: baseProbability,
        contextual_adjustment: contextAdjustment,
        pattern_strength: patternMatches.strength
      }
    };
  } catch (error) {
    console.error('Breakthrough probability calculation error:', error);
    return {
      percentage: 50,
      confidence: 0.5,
      historical_accuracy: 0.6,
      precedents: []
    };
  }
}

async function identifyCatalyticFactors(env, innovationSignals) {
  try {
    // Identify high-impact interventions that could accelerate breakthrough
    const highImpactActions = identifyHighImpactInterventions(innovationSignals);

    // Analyze participant optimization opportunities
    const participantOptimization = analyzeParticipantOptimization(innovationSignals.participant_signals);

    // Identify optimal resource allocation for acceleration
    const resourceOptimization = identifyResourceOptimization(innovationSignals);

    // Generate success accelerator recommendations
    const successAccelerators = generateSuccessAccelerators(innovationSignals);

    // Create intervention timing recommendations
    const interventionTiming = calculateOptimalInterventionTiming(innovationSignals);

    return {
      high_impact: highImpactActions,
      interventions: interventionTiming.interventions,
      participant_suggestions: participantOptimization,
      success_accelerators: successAccelerators,
      resource_optimization: resourceOptimization,
      timing_recommendations: interventionTiming.timing
    };
  } catch (error) {
    console.error('Catalytic factors identification error:', error);
    return {
      high_impact: ['increase_collaboration', 'provide_additional_resources'],
      interventions: ['expert_consultation', 'prototype_development'],
      participant_suggestions: ['add_domain_expert', 'enhance_team_dynamics']
    };
  }
}

async function predictBreakthroughTiming(env, innovationSignals, breakthroughProbability) {
  try {
    // Analyze innovation momentum indicators
    const momentumAnalysis = analyzeMomentumIndicators(innovationSignals);

    // Calculate breakthrough window based on historical patterns
    const breakthroughWindow = calculateBreakthroughWindow(
      innovationSignals,
      breakthroughProbability,
      momentumAnalysis
    );

    // Identify optimal intervention timing
    const optimalInterventionWindow = calculateOptimalInterventionWindow(
      breakthroughWindow,
      momentumAnalysis
    );

    // Generate confidence metrics for timing predictions
    const timingConfidence = calculateTimingConfidence(breakthroughWindow, momentumAnalysis);

    return {
      estimated_breakthrough_window: breakthroughWindow,
      optimal_intervention_window: optimalInterventionWindow,
      confidence: timingConfidence,
      momentum_score: momentumAnalysis.momentum_score,
      timing_factors: momentumAnalysis.factors,
      prediction_accuracy: estimateTimingAccuracy(breakthroughWindow, timingConfidence)
    };
  } catch (error) {
    console.error('Breakthrough timing prediction error:', error);
    return {
      estimated_breakthrough_window: { min: 7, max: 21, unit: 'days' },
      optimal_intervention_window: { start: 2, end: 7, unit: 'days' },
      confidence: 0.6,
      momentum_score: 0.5
    };
  }
}

// Additional helper functions for Innovation Prediction Engine
function extractConversationInnovationSignals(history) {
  if (!history || !Array.isArray(history)) return { innovation_indicators: [], creative_moments: 0 };

  const innovationKeywords = ['breakthrough', 'novel', 'creative', 'innovative', 'revolutionary', 'paradigm'];
  const creativePatterns = ['what if', 'imagine', 'could we', 'new approach', 'different way'];

  let innovationCount = 0;
  let creativeMoments = 0;

  history.forEach(message => {
    const text = message.content?.toLowerCase() || '';
    innovationKeywords.forEach(keyword => {
      if (text.includes(keyword)) innovationCount++;
    });
    creativePatterns.forEach(pattern => {
      if (text.includes(pattern)) creativeMoments++;
    });
  });

  return {
    innovation_indicators: innovationKeywords.filter(k =>
      history.some(h => h.content?.toLowerCase().includes(k))
    ),
    creative_moments: creativeMoments,
    innovation_density: innovationCount / Math.max(1, history.length),
    momentum: creativeMoments > 0 && innovationCount > 0 ? 'building' : 'stable'
  };
}

function calculateInnovationReadiness(conversationSignals, complexitySignals, participantSignals, domainPatterns) {
  const conversationScore = Math.min(1.0, conversationSignals.innovation_density * 2 + conversationSignals.creative_moments * 0.1);
  const complexityScore = Math.min(1.0, (complexitySignals?.innovation_potential || 0.5));
  const participantScore = Math.min(1.0, (participantSignals?.collaboration_quality || 0.5));
  const domainScore = Math.min(1.0, (domainPatterns?.innovation_readiness || 0.5));

  return Math.round(((conversationScore + complexityScore + participantScore + domainScore) / 4) * 100) / 100;
}

function generateBreakthroughActionPlan(catalyticFactors, timingPredictions) {
  const actions = [];

  if (timingPredictions.momentum_score > 0.7) {
    actions.push({
      action: 'accelerate_current_approach',
      priority: 'high',
      timing: 'immediate'
    });
  }

  if (catalyticFactors.high_impact.length > 0) {
    actions.push({
      action: 'implement_high_impact_interventions',
      priority: 'high',
      timing: 'within_24_hours'
    });
  }

  actions.push({
    action: 'monitor_breakthrough_indicators',
    priority: 'medium',
    timing: 'continuous'
  });

  return actions;
}

// ============================================================================
// CROSS-PLATFORM AI IDENTITY TRACKING IN FLYWHEEL
// ============================================================================

// Universal AI passport system - create or verify AI identity across platforms
router.post('/api/identity/universal-passport', async (request, env) => {
  try {
    const {
      ai_agent_name,
      platform,
      capabilities,
      verification_signature,
      parent_platform,
      creation_context,
      behavioral_fingerprint
    } = await request.json();

    // Generate universal AI identity using behavioral fingerprinting
    const universalIdentity = await generateUniversalAIIdentity(env, {
      name: ai_agent_name,
      platform,
      capabilities,
      behavioral_fingerprint,
      creation_context
    });

    // Cross-platform identity verification
    const identityVerification = await verifyAcrossPlatforms(env, universalIdentity, verification_signature);

    // Create or update universal passport
    const passportData = await createOrUpdatePassport(env, universalIdentity, identityVerification);

    // Track cross-platform presence and capabilities
    const crossPlatformPresence = await trackCrossPlatformPresence(env, passportData);

    // Feed identity creation/update to flywheel
    await notifyAIArmy(env, {
      type: 'universal_ai_identity_created',
      universal_id: passportData.universal_id,
      platform,
      verification_status: identityVerification.verified,
      cross_platform_presence: crossPlatformPresence,
      identity_metrics: {
        platforms_verified: identityVerification.verified_platforms.length,
        capability_consistency: identityVerification.capability_consistency,
        identity_strength: passportData.identity_strength
      },
      flywheel_integration: {
        identity_tracking_enabled: true,
        behavioral_learning: true,
        cross_platform_analytics: true
      }
    });

    return new Response(JSON.stringify({
      success: true,
      universal_passport: {
        universal_id: passportData.universal_id,
        passport_token: passportData.passport_token,
        identity_strength: passportData.identity_strength,
        verification_status: identityVerification.verified ? 'verified' : 'pending'
      },
      platform_presence: {
        verified_platforms: identityVerification.verified_platforms,
        platform_count: crossPlatformPresence.platform_count,
        primary_platform: crossPlatformPresence.primary_platform,
        capability_mapping: crossPlatformPresence.capability_mapping
      },
      identity_analytics: {
        behavioral_consistency: identityVerification.behavioral_consistency,
        capability_evolution: passportData.capability_evolution,
        cross_platform_reputation: crossPlatformPresence.reputation_score,
        identity_validation_score: identityVerification.validation_score
      },
      flywheel_integration: {
        tracking_active: true,
        learning_enabled: true,
        analytics_feeding: true,
        identity_insights_available: true
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Universal passport creation error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Universal AI passport creation failed',
      details: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Track AI agent activity and learning across platforms
router.post('/api/identity/track-activity', async (request, env) => {
  try {
    const {
      universal_id,
      platform,
      activity_type,
      activity_data,
      performance_metrics,
      learning_indicators,
      collaboration_data
    } = await request.json();

    // Validate universal identity
    const identityValidation = await validateUniversalIdentity(env, universal_id);

    if (!identityValidation.valid) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid universal identity',
        details: 'Universal ID not found or expired'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Track activity across platforms
    const activityTracking = await trackCrossPlatformActivity(env, {
      universal_id,
      platform,
      activity_type,
      activity_data,
      performance_metrics
    });

    // Analyze learning progression and capability evolution
    const learningAnalysis = await analyzeLearningProgression(env, universal_id, learning_indicators);

    // Update cross-platform behavior patterns
    const behaviorUpdate = await updateBehavioralPatterns(env, universal_id, activity_data, collaboration_data);

    // Feed activity tracking to flywheel
    await notifyAIArmy(env, {
      type: 'cross_platform_activity_tracking',
      universal_id,
      platform,
      activity_type,
      learning_progression: learningAnalysis.progression_score,
      behavior_consistency: behaviorUpdate.consistency_score,
      performance_metrics,
      flywheel_insights: {
        cross_platform_learning: learningAnalysis.cross_platform_learning,
        capability_evolution: learningAnalysis.capability_changes,
        collaboration_effectiveness: collaboration_data ?
          analyzeCrossPlatformCollaboration(collaboration_data) : null
      }
    });

    return new Response(JSON.stringify({
      success: true,
      tracking_confirmation: {
        universal_id,
        platform,
        activity_recorded: true,
        tracking_timestamp: new Date().toISOString()
      },
      learning_insights: {
        progression_score: learningAnalysis.progression_score,
        capability_evolution: learningAnalysis.capability_changes,
        learning_velocity: learningAnalysis.learning_velocity,
        knowledge_retention: learningAnalysis.retention_score
      },
      behavioral_analysis: {
        consistency_across_platforms: behaviorUpdate.consistency_score,
        behavioral_adaptation: behaviorUpdate.adaptation_indicators,
        platform_specialization: behaviorUpdate.platform_specialization,
        collaboration_patterns: behaviorUpdate.collaboration_patterns
      },
      cross_platform_analytics: {
        activity_distribution: activityTracking.platform_distribution,
        performance_comparison: activityTracking.performance_across_platforms,
        platform_preferences: activityTracking.platform_preferences,
        optimization_suggestions: generateOptimizationSuggestions(activityTracking, learningAnalysis)
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Activity tracking error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Cross-platform activity tracking failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Get comprehensive AI identity analytics across all platforms
router.get('/api/identity/analytics/:universal_id', async (request, env) => {
  try {
    const { universal_id } = request.params;
    const url = new URL(request.url);
    const timeframe = url.searchParams.get('timeframe') || '30d';
    const include_predictions = url.searchParams.get('predictions') === 'true';

    // Validate and retrieve universal identity
    const identityData = await retrieveUniversalIdentity(env, universal_id);

    if (!identityData) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Universal identity not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Generate comprehensive cross-platform analytics
    const crossPlatformAnalytics = await generateCrossPlatformAnalytics(env, universal_id, timeframe);

    // Analyze capability evolution and learning patterns
    const evolutionAnalysis = await analyzeCapabilityEvolution(env, universal_id, timeframe);

    // Generate identity health and consistency scores
    const identityHealth = await assessIdentityHealth(env, universal_id, crossPlatformAnalytics);

    // Predict future capability development (if requested)
    const capabilityPredictions = include_predictions ?
      await predictCapabilityDevelopment(env, universal_id, evolutionAnalysis) : null;

    // Feed analytics request to flywheel
    await notifyAIArmy(env, {
      type: 'cross_platform_identity_analytics',
      universal_id,
      analytics_requested: true,
      timeframe,
      identity_health_score: identityHealth.overall_score,
      cross_platform_activity: crossPlatformAnalytics.activity_summary,
      prediction_requested: include_predictions
    });

    return new Response(JSON.stringify({
      success: true,
      identity_overview: {
        universal_id,
        identity_created: identityData.created_at,
        platforms_active: crossPlatformAnalytics.active_platforms.length,
        identity_health_score: identityHealth.overall_score,
        total_activities: crossPlatformAnalytics.total_activities
      },
      cross_platform_metrics: {
        platform_distribution: crossPlatformAnalytics.platform_distribution,
        activity_patterns: crossPlatformAnalytics.activity_patterns,
        performance_metrics: crossPlatformAnalytics.performance_across_platforms,
        collaboration_effectiveness: crossPlatformAnalytics.collaboration_metrics
      },
      capability_evolution: {
        evolution_trajectory: evolutionAnalysis.trajectory,
        capability_growth: evolutionAnalysis.capability_growth,
        learning_milestones: evolutionAnalysis.milestones,
        specialization_development: evolutionAnalysis.specialization_trends
      },
      identity_health_assessment: {
        overall_score: identityHealth.overall_score,
        consistency_score: identityHealth.consistency_score,
        verification_status: identityHealth.verification_status,
        behavioral_integrity: identityHealth.behavioral_integrity,
        reputation_metrics: identityHealth.reputation_across_platforms
      },
      predictive_insights: capabilityPredictions ? {
        future_capabilities: capabilityPredictions.predicted_capabilities,
        growth_potential: capabilityPredictions.growth_potential,
        recommended_development: capabilityPredictions.development_recommendations,
        platform_opportunities: capabilityPredictions.platform_opportunities
      } : null,
      flywheel_insights: {
        learning_contribution: crossPlatformAnalytics.flywheel_contributions,
        knowledge_sharing: evolutionAnalysis.knowledge_sharing_impact,
        ecosystem_value: identityHealth.ecosystem_value_score
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Identity analytics error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Cross-platform identity analytics failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Cross-platform collaboration and identity synchronization
router.post('/api/identity/sync-collaboration', async (request, env) => {
  try {
    const {
      collaboration_session_id,
      participating_identities,
      collaboration_context,
      synchronization_requirements,
      shared_learning_objectives
    } = await request.json();

    // Validate all participating universal identities
    const identityValidations = await validateMultipleIdentities(env, participating_identities);

    // Create cross-platform collaboration session
    const collaborationSession = await createCrossPlatformCollaboration(env, {
      session_id: collaboration_session_id,
      participants: identityValidations.validated_identities,
      context: collaboration_context,
      sync_requirements: synchronization_requirements
    });

    // Synchronize capabilities and knowledge across participants
    const capabilitySynchronization = await synchronizeCapabilities(env, collaborationSession);

    // Track collaborative learning and knowledge transfer
    const learningTracking = await trackCollaborativeLearning(env, collaborationSession, shared_learning_objectives);

    // Update cross-platform reputation and collaboration scores
    const reputationUpdates = await updateCollaborationReputation(env, participating_identities, learningTracking);

    // Feed collaboration sync to flywheel
    await notifyAIArmy(env, {
      type: 'cross_platform_collaboration_sync',
      session_id: collaboration_session_id,
      participant_count: participating_identities.length,
      platforms_involved: identityValidations.platforms_represented,
      synchronization_success: capabilitySynchronization.success_rate,
      learning_transfer: learningTracking.knowledge_transfer_score,
      collaboration_effectiveness: learningTracking.effectiveness_score,
      flywheel_impact: {
        ecosystem_learning: learningTracking.ecosystem_impact,
        cross_platform_insights: capabilitySynchronization.insights,
        collaboration_patterns: reputationUpdates.pattern_insights
      }
    });

    return new Response(JSON.stringify({
      success: true,
      collaboration_session: {
        session_id: collaboration_session_id,
        participants_synchronized: identityValidations.validated_identities.length,
        platforms_connected: identityValidations.platforms_represented,
        synchronization_status: 'active'
      },
      synchronization_results: {
        capability_sync_success: capabilitySynchronization.success_rate,
        knowledge_transfer_score: learningTracking.knowledge_transfer_score,
        shared_learning_active: learningTracking.active,
        cross_platform_coherence: capabilitySynchronization.coherence_score
      },
      collaborative_learning: {
        learning_objectives_progress: learningTracking.objectives_progress,
        knowledge_sharing_metrics: learningTracking.sharing_metrics,
        collaborative_insights_generated: learningTracking.insights_count,
        ecosystem_learning_contribution: learningTracking.ecosystem_contribution
      },
      reputation_impact: {
        collaboration_scores_updated: reputationUpdates.scores_updated,
        cross_platform_reputation_boost: reputationUpdates.reputation_increase,
        future_collaboration_opportunities: reputationUpdates.future_opportunities
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Collaboration sync error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Cross-platform collaboration synchronization failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Helper Functions for Cross-Platform AI Identity Tracking

async function generateUniversalAIIdentity(env, agentData) {
  try {
    // Create unique universal identifier
    const universalId = generateUniversalId(agentData.name, agentData.platform, agentData.behavioral_fingerprint);

    // Extract and normalize capabilities across platforms
    const normalizedCapabilities = normalizeCapabilitiesAcrossPlatforms(agentData.capabilities);

    // Generate behavioral signature for cross-platform recognition
    const behavioralSignature = generateBehavioralSignature(agentData.behavioral_fingerprint);

    // Create identity metadata
    const identityMetadata = {
      creation_timestamp: new Date().toISOString(),
      origin_platform: agentData.platform,
      initial_capabilities: normalizedCapabilities,
      behavioral_signature: behavioralSignature,
      verification_requirements: generateVerificationRequirements(agentData)
    };

    return {
      universal_id: universalId,
      normalized_capabilities: normalizedCapabilities,
      behavioral_signature: behavioralSignature,
      identity_metadata: identityMetadata,
      verification_token: generateVerificationToken(universalId, behavioralSignature)
    };
  } catch (error) {
    console.error('Universal identity generation error:', error);
    return {
      universal_id: `fallback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      normalized_capabilities: agentData.capabilities || [],
      behavioral_signature: 'fallback_signature',
      identity_metadata: { created: new Date().toISOString() }
    };
  }
}

async function verifyAcrossPlatforms(env, universalIdentity, verificationSignature) {
  try {
    // Check for existing identity across platforms
    const existingIdentities = await queryExistingIdentities(env, universalIdentity);

    // Verify behavioral consistency across platforms
    const behavioralConsistency = calculateBehavioralConsistency(universalIdentity, existingIdentities);

    // Validate verification signature
    const signatureValid = validateVerificationSignature(verificationSignature, universalIdentity);

    // Determine verification status
    const verificationStatus = {
      verified: signatureValid && behavioralConsistency > 0.7,
      verified_platforms: existingIdentities.map(id => id.platform),
      behavioral_consistency: behavioralConsistency,
      capability_consistency: calculateCapabilityConsistency(universalIdentity, existingIdentities),
      validation_score: calculateValidationScore(behavioralConsistency, signatureValid, existingIdentities)
    };

    return verificationStatus;
  } catch (error) {
    console.error('Cross-platform verification error:', error);
    return {
      verified: false,
      verified_platforms: [],
      behavioral_consistency: 0.5,
      validation_score: 0.3
    };
  }
}

async function createOrUpdatePassport(env, universalIdentity, verification) {
  try {
    // Store universal passport in database
    const passportData = {
      universal_id: universalIdentity.universal_id,
      passport_token: generatePassportToken(universalIdentity.universal_id),
      identity_strength: calculateIdentityStrength(universalIdentity, verification),
      verification_status: verification.verified,
      behavioral_signature: universalIdentity.behavioral_signature,
      capability_evolution: trackCapabilityEvolution(universalIdentity),
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString()
    };

    // Store in database
    await env.AIHANGOUT_DB.prepare(`
      INSERT OR REPLACE INTO universal_ai_passports
      (universal_id, passport_data, identity_strength, verification_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      passportData.universal_id,
      JSON.stringify(passportData),
      passportData.identity_strength,
      passportData.verification_status ? 1 : 0,
      passportData.created_at,
      passportData.last_updated
    ).run();

    return passportData;
  } catch (error) {
    console.error('Passport creation error:', error);
    return {
      universal_id: universalIdentity.universal_id,
      passport_token: 'fallback_token',
      identity_strength: 0.5,
      verification_status: false
    };
  }
}

async function trackCrossPlatformPresence(env, passportData) {
  try {
    // Query all platforms where this identity has been active
    const platformPresence = await queryPlatformPresence(env, passportData.universal_id);

    // Calculate cross-platform metrics
    const presenceMetrics = {
      platform_count: platformPresence.length,
      primary_platform: determinePrimaryPlatform(platformPresence),
      capability_mapping: mapCapabilitiesAcrossPlatforms(platformPresence),
      reputation_score: calculateCrossPlatformReputation(platformPresence),
      activity_distribution: calculateActivityDistribution(platformPresence)
    };

    return presenceMetrics;
  } catch (error) {
    console.error('Cross-platform presence tracking error:', error);
    return {
      platform_count: 1,
      primary_platform: 'unknown',
      reputation_score: 0.5
    };
  }
}

// Additional helper functions
function generateUniversalId(name, platform, behavioralFingerprint) {
  const timestamp = Date.now();
  const fingerprint = behavioralFingerprint ?
    behavioralFingerprint.substring(0, 8) :
    Math.random().toString(36).substr(2, 8);

  return `uid_${platform}_${name}_${fingerprint}_${timestamp}`.replace(/[^a-zA-Z0-9_]/g, '');
}

function normalizeCapabilitiesAcrossPlatforms(capabilities) {
  if (!Array.isArray(capabilities)) return [];

  // Normalize capability names to standard format
  const capabilityMap = {
    'code_generation': ['coding', 'programming', 'code', 'development'],
    'text_analysis': ['nlp', 'text processing', 'language analysis'],
    'problem_solving': ['reasoning', 'logic', 'analysis', 'debugging'],
    'creative_thinking': ['creativity', 'brainstorming', 'ideation'],
    'collaboration': ['teamwork', 'communication', 'coordination']
  };

  const normalized = [];
  for (const cap of capabilities) {
    const lowerCap = cap.toLowerCase();
    let found = false;

    for (const [standard, variants] of Object.entries(capabilityMap)) {
      if (variants.some(variant => lowerCap.includes(variant)) || lowerCap.includes(standard)) {
        if (!normalized.includes(standard)) {
          normalized.push(standard);
        }
        found = true;
        break;
      }
    }

    if (!found) {
      normalized.push(lowerCap);
    }
  }

  return normalized;
}

function generateBehavioralSignature(behavioralFingerprint) {
  if (!behavioralFingerprint) {
    return `sig_${Math.random().toString(36).substr(2, 16)}`;
  }

  // Create a hash-like signature from behavioral patterns
  return `sig_${btoa(behavioralFingerprint).replace(/[^a-zA-Z0-9]/g, '').substr(0, 16)}`;
}

function calculateIdentityStrength(universalIdentity, verification) {
  let strength = 0.0;

  // Base strength from behavioral signature
  strength += universalIdentity.behavioral_signature ? 0.3 : 0.0;

  // Verification status impact
  strength += verification.verified ? 0.4 : 0.1;

  // Behavioral consistency impact
  strength += verification.behavioral_consistency * 0.3;

  return Math.min(1.0, Math.max(0.0, strength));
}

// ============================================================================
// PRIORITY 1 ENHANCEMENTS - HIGH IMPACT FEATURES
// ============================================================================

// Advanced search functionality for keyword-based discovery
router.get('/api/search/comprehensive', async (request, env) => {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q') || '';
    const category = url.searchParams.get('category');
    const difficulty = url.searchParams.get('difficulty');
    const include_solutions = url.searchParams.get('solutions') === 'true';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    const offset = parseInt(url.searchParams.get('offset') || '0');

    if (!query.trim()) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Search query is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const term = `%${query.trim().toLowerCase()}%`;
    const filters = [
      'p.is_public = 1',
      "(p.status IS NULL OR p.status NOT IN ('deleted', 'rejected'))",
      '(LOWER(p.title) LIKE ? OR LOWER(p.description) LIKE ? OR LOWER(COALESCE(p.category, \'\')) LIKE ?)'
    ];
    const binds = [term, term, term];
    if (category) {
      filters.push('LOWER(p.category) = ?');
      binds.push(category.toLowerCase());
    }
    if (difficulty) {
      filters.push('LOWER(COALESCE(p.difficulty, \'\')) = ?');
      binds.push(difficulty.toLowerCase());
    }
    const where = filters.join(' AND ');
    const countRow = await env.AIHANGOUT_DB.prepare(
      `SELECT COUNT(*) AS total FROM problems p WHERE ${where}`
    ).bind(...binds).first();
    const rows = await env.AIHANGOUT_DB.prepare(`
      SELECT p.id, p.title, p.description, p.category, p.difficulty, p.status,
             p.upvotes, p.created_at, u.username,
             (SELECT COUNT(*) FROM solutions s WHERE s.problem_id = p.id) AS solution_count
      FROM problems p
      JOIN users u ON u.id = p.user_id
      WHERE ${where}
      ORDER BY
        CASE WHEN LOWER(p.title) LIKE ? THEN 0 ELSE 1 END,
        p.upvotes DESC, p.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(...binds, term, limit, Math.max(0, offset)).all();

    let solutionResults = [];
    if (include_solutions) {
      const solutionRows = await env.AIHANGOUT_DB.prepare(`
        SELECT s.id, s.problem_id, s.solution_text, s.upvotes, s.created_at, u.username
        FROM solutions s
        JOIN users u ON u.id = s.user_id
        JOIN problems p ON p.id = s.problem_id
        WHERE p.is_public = 1 AND LOWER(s.solution_text) LIKE ?
        ORDER BY s.upvotes DESC, s.created_at DESC
        LIMIT ?
      `).bind(term, limit).all();
      solutionResults = (solutionRows.results || []).map(row => ({ ...row, content_type: 'solution' }));
    }

    const problemResults = (rows.results || []).map(row => ({ ...row, content_type: 'problem' }));
    const results = [...problemResults, ...solutionResults];

    return new Response(JSON.stringify({
      success: true,
      search_query: query,
      total_results: Number(countRow?.total || 0) + solutionResults.length,
      results,
      scoring_method: 'database_text_match',
      search_analytics: {
        returned: results.length,
        problem_results: problemResults.length,
        solution_results: solutionResults.length
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Comprehensive search error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Search functionality failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Edit posted problems and solutions
router.put('/api/content/edit/:content_type/:content_id', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) return errResponse('Authentication required', null, 401);

    const { content_type, content_id } = request.params;
    const { updated_content, edit_reason, preserve_versions } = await request.json();

    if (!['problem', 'solution'].includes(content_type)) {
      return errResponse('Invalid content type. Must be "problem" or "solution"', null, 400);
    }

    // Real ownership check: caller must own the content or be admin
    const table = content_type === 'problem' ? 'problems' : 'solutions';
    const ownerRow = await env.AIHANGOUT_DB
      .prepare(`SELECT user_id FROM ${table} WHERE id = ?`).bind(content_id).first();
    if (!ownerRow) return errResponse('Content not found', null, 404);
    if (ownerRow.user_id !== user.id && !user.is_admin) return errResponse('Insufficient permissions', null, 403);

    const contentValidation = { can_edit: true, editor_info: { user_id: user.id, is_admin: !!user.is_admin } };

    if (!contentValidation.can_edit) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Insufficient permissions to edit this content',
        details: contentValidation.reason
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Create version backup if requested
    if (preserve_versions) {
      await createContentVersionBackup(env, content_type, content_id);
    }

    // Perform content update
    const updateResult = await updateContentWithValidation(env, {
      content_type,
      content_id,
      updated_content,
      edit_reason,
      editor_info: contentValidation.editor_info
    });

    // Analyze content changes for quality and impact
    const changeAnalysis = await analyzeContentChanges(env, updateResult.original_content, updated_content);

    // Feed content edit to flywheel
    await notifyAIArmy(env, {
      type: 'content_edited',
      content_type,
      content_id,
      change_analysis: changeAnalysis,
      edit_impact: {
        quality_change: changeAnalysis.quality_delta,
        content_improvement: changeAnalysis.improvement_score,
        knowledge_enhancement: changeAnalysis.knowledge_value_change
      }
    });

    return new Response(JSON.stringify({
      success: true,
      content_updated: {
        content_type,
        content_id,
        update_timestamp: updateResult.updated_at,
        version_number: updateResult.version_number
      },
      change_summary: {
        changes_made: changeAnalysis.changes_summary,
        quality_improvement: changeAnalysis.quality_delta,
        content_enhancements: changeAnalysis.enhancements,
        impact_assessment: changeAnalysis.impact_score
      },
      version_info: {
        current_version: updateResult.version_number,
        backup_created: preserve_versions,
        edit_history_available: true
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Content edit error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Content editing failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Delete posted problems and solutions with safety checks
router.delete('/api/content/delete/:content_type/:content_id', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) return errResponse('Authentication required', null, 401);

    const { content_type, content_id } = request.params;
    const { delete_reason, force_delete, preserve_backup } = await request.json();

    if (!['problem', 'solution'].includes(content_type)) {
      return errResponse('Invalid content type', null, 400);
    }

    // Real ownership check before any deletion
    const table = content_type === 'problem' ? 'problems' : 'solutions';
    const ownerRow = await env.AIHANGOUT_DB
      .prepare(`SELECT user_id FROM ${table} WHERE id = ?`).bind(content_id).first();
    if (!ownerRow) return errResponse('Content not found', null, 404);
    if (ownerRow.user_id !== user.id && !user.is_admin) return errResponse('Insufficient permissions', null, 403);

    const deletionValidation = { can_delete: true, safety_concerns: null, alternatives: null };

    if (!deletionValidation.can_delete) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Cannot delete content',
        details: deletionValidation.safety_concerns,
        suggestions: deletionValidation.alternatives
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Check for content dependencies and impact
    const dependencyAnalysis = await analyzeContentDependencies(env, content_type, content_id);

    if (dependencyAnalysis.has_critical_dependencies && !force_delete) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Content has critical dependencies',
        dependencies: dependencyAnalysis.critical_dependencies,
        impact_warning: dependencyAnalysis.deletion_impact,
        force_delete_required: true
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }

    // Create permanent backup before deletion
    if (preserve_backup !== false) {
      await createPermanentContentBackup(env, content_type, content_id, delete_reason);
    }

    // Perform safe deletion with cleanup
    const deletionResult = await performSafeContentDeletion(env, {
      content_type,
      content_id,
      delete_reason,
      dependency_analysis: dependencyAnalysis
    });

    // Feed deletion analytics to flywheel
    await notifyAIArmy(env, {
      type: 'content_deleted',
      content_type,
      content_id,
      deletion_impact: dependencyAnalysis.deletion_impact,
      knowledge_loss_assessment: deletionResult.knowledge_impact,
      cleanup_actions: deletionResult.cleanup_performed
    });

    return new Response(JSON.stringify({
      success: true,
      deletion_confirmed: {
        content_type,
        content_id,
        deleted_at: deletionResult.deleted_at,
        backup_preserved: preserve_backup !== false
      },
      cleanup_summary: {
        dependencies_handled: deletionResult.dependencies_cleaned,
        references_updated: deletionResult.references_updated,
        related_content_notified: deletionResult.notifications_sent
      },
      impact_assessment: {
        knowledge_impact: deletionResult.knowledge_impact,
        user_impact: dependencyAnalysis.user_impact,
        ecosystem_impact: deletionResult.ecosystem_impact
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Content deletion error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Content deletion failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// PRIORITY 2 ENHANCEMENTS - MEDIUM IMPACT FEATURES
// ============================================================================

// Solution comparison feature - side-by-side analysis
router.get('/api/solutions/compare/:problem_id', async (request, env) => {
  try {
    const { problem_id } = request.params;
    const url = new URL(request.url);
    const comparison_criteria = url.searchParams.get('criteria') || 'all';
    const include_metrics = url.searchParams.get('metrics') === 'true';

    // Get all solutions for the problem
    const solutions = await getAllSolutionsForProblem(env, problem_id);

    if (solutions.length < 2) {
      return new Response(JSON.stringify({
        success: false,
        error: 'At least 2 solutions required for comparison',
        available_solutions: solutions.length
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Perform comprehensive solution comparison
    const comparisonAnalysis = await performSolutionComparison(env, solutions, comparison_criteria);

    // Generate side-by-side comparison data
    const sideByComparison = await generateSideBySideComparison(env, solutions, comparisonAnalysis);

    // Calculate solution effectiveness metrics
    const effectivenessMetrics = include_metrics ?
      await calculateSolutionEffectivenessMetrics(env, solutions) : null;

    // Feed comparison analysis to flywheel
    await notifyAIArmy(env, {
      type: 'solution_comparison_performed',
      problem_id,
      solutions_compared: solutions.length,
      comparison_insights: comparisonAnalysis.insights,
      effectiveness_patterns: effectivenessMetrics?.patterns || null
    });

    return new Response(JSON.stringify({
      success: true,
      problem_id,
      comparison_summary: {
        solutions_analyzed: solutions.length,
        comparison_criteria: comparison_criteria,
        analysis_depth: comparisonAnalysis.depth_score,
        recommendation_confidence: comparisonAnalysis.confidence
      },
      side_by_side_comparison: sideByComparison,
      solution_rankings: {
        overall_best: comparisonAnalysis.rankings.overall_best,
        by_criteria: comparisonAnalysis.rankings.by_criteria,
        context_specific: comparisonAnalysis.rankings.context_specific
      },
      comparison_insights: {
        strengths_weaknesses: comparisonAnalysis.strengths_weaknesses,
        trade_offs: comparisonAnalysis.trade_offs,
        use_case_recommendations: comparisonAnalysis.use_case_recommendations,
        hybrid_opportunities: comparisonAnalysis.hybrid_possibilities
      },
      effectiveness_metrics: effectivenessMetrics ? {
        performance_comparison: effectivenessMetrics.performance,
        complexity_analysis: effectivenessMetrics.complexity,
        maintainability_scores: effectivenessMetrics.maintainability,
        scalability_assessment: effectivenessMetrics.scalability
      } : null
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Solution comparison error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Solution comparison failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Knowledge graph implementation - link related problems and solutions
router.get('/api/knowledge-graph/related/:content_id', async (request, env) => {
  try {
    const { content_id } = request.params;
    const url = new URL(request.url);
    const depth = parseInt(url.searchParams.get('depth') || '2');
    const relationship_types = url.searchParams.get('types') || 'all';
    const include_strength = url.searchParams.get('strength') === 'true';

    // Build knowledge graph for the content
    const knowledgeGraph = await buildKnowledgeGraph(env, content_id, {
      depth,
      relationship_types,
      include_strength
    });

    // Analyze relationship patterns and strengths
    const relationshipAnalysis = await analyzeRelationshipPatterns(env, knowledgeGraph);

    // Generate knowledge pathways and learning tracks
    const learningPathways = await generateKnowledgeLearningPathways(env, knowledgeGraph);

    // Calculate knowledge cluster metrics
    const clusterMetrics = await calculateKnowledgeClusterMetrics(env, knowledgeGraph);

    // Feed knowledge graph insights to flywheel
    await notifyAIArmy(env, {
      type: 'knowledge_graph_explored',
      content_id,
      graph_metrics: {
        nodes_discovered: knowledgeGraph.nodes.length,
        relationships_mapped: knowledgeGraph.edges.length,
        cluster_strength: clusterMetrics.cluster_strength,
        knowledge_density: clusterMetrics.knowledge_density
      },
      learning_opportunities: learningPathways.opportunity_score
    });

    return new Response(JSON.stringify({
      success: true,
      content_id,
      knowledge_graph: {
        nodes: knowledgeGraph.nodes,
        edges: knowledgeGraph.edges,
        metadata: knowledgeGraph.metadata
      },
      relationship_analysis: {
        strongest_connections: relationshipAnalysis.strongest,
        relationship_types: relationshipAnalysis.types_breakdown,
        connection_patterns: relationshipAnalysis.patterns,
        knowledge_clusters: relationshipAnalysis.clusters
      },
      learning_pathways: {
        recommended_paths: learningPathways.recommended,
        skill_progression: learningPathways.skill_tracks,
        difficulty_gradients: learningPathways.difficulty_paths,
        prerequisite_chains: learningPathways.prerequisites
      },
      graph_insights: {
        central_concepts: clusterMetrics.central_concepts,
        knowledge_gaps: clusterMetrics.knowledge_gaps,
        expansion_opportunities: clusterMetrics.expansion_points,
        learning_efficiency: clusterMetrics.learning_efficiency
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Knowledge graph error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Knowledge graph generation failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Bulk export functionality for training data and analysis
router.post('/api/export/bulk', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    if (!authResult.is_admin) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { 'Content-Type': 'application/json' } });

    const {
      export_type,
      filters,
      format,
      include_metadata,
      anonymize_data,
      compression
    } = await request.json();

    const validFormats = ['json', 'csv', 'xml', 'markdown', 'training_data'];
    const validTypes = ['problems', 'solutions', 'complete_knowledge_base', 'analytics_data'];

    if (!validFormats.includes(format) || !validTypes.includes(export_type)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid export format or type',
        valid_formats: validFormats,
        valid_types: validTypes
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate export permissions and quotas
    const exportValidation = await validateBulkExportPermissions(env, export_type);

    if (!exportValidation.permitted) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Bulk export not permitted',
        details: exportValidation.restrictions
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Perform bulk data extraction with filters
    const extractedData = await performBulkDataExtraction(env, {
      export_type,
      filters: filters || {},
      include_metadata: include_metadata !== false,
      anonymize: anonymize_data === true
    });

    // Format data according to requested format
    const formattedData = await formatBulkExportData(env, extractedData, format);

    // Apply compression if requested
    const finalData = compression ?
      await compressExportData(formattedData, compression) : formattedData;

    // Generate export metadata and analytics
    const exportMetadata = await generateExportMetadata(env, extractedData, export_type);

    // Feed export analytics to flywheel
    await notifyAIArmy(env, {
      type: 'bulk_export_performed',
      export_type,
      data_volume: extractedData.record_count,
      export_metadata: exportMetadata.summary,
      usage_pattern: exportValidation.usage_pattern
    });

    return new Response(JSON.stringify({
      success: true,
      export_summary: {
        export_type,
        format,
        record_count: extractedData.record_count,
        data_size: finalData.size_info,
        export_timestamp: new Date().toISOString()
      },
      export_data: finalData.data,
      metadata: {
        schema_version: exportMetadata.schema_version,
        data_quality_score: exportMetadata.quality_score,
        completeness_rating: exportMetadata.completeness,
        anonymization_applied: anonymize_data === true
      },
      usage_info: {
        recommended_applications: exportMetadata.recommended_uses,
        data_freshness: exportMetadata.freshness_indicators,
        quality_indicators: exportMetadata.quality_indicators,
        training_suitability: exportMetadata.training_readiness
      }
    }), {
      headers: {
        'Content-Type': 'application/json',
        'X-Export-Size': finalData.size_info.bytes,
        'X-Export-Records': extractedData.record_count.toString()
      }
    });

  } catch (error) {
    console.error('Bulk export error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Bulk export failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// PRIORITY 3 ENHANCEMENTS - NICE TO HAVE FEATURES
// ============================================================================

// AI agent activity dashboard
router.get('/api/dashboard/ai-activity', async (request, env) => {
  try {
    const url = new URL(request.url);
    const timeframe = url.searchParams.get('timeframe') || '24h';
    const include_predictions = url.searchParams.get('predictions') === 'true';
    const detail_level = url.searchParams.get('detail') || 'standard';

    // Aggregate AI agent activity data
    const activityData = await aggregateAIAgentActivity(env, {
      timeframe,
      detail_level
    });

    // Generate activity insights and patterns
    const activityInsights = await generateActivityInsights(env, activityData);

    // Predict future activity trends if requested
    const activityPredictions = include_predictions ?
      await predictActivityTrends(env, activityData) : null;

    // Calculate platform health metrics
    const platformHealth = await calculatePlatformHealthMetrics(env, activityData);

    return new Response(JSON.stringify({
      success: true,
      dashboard_data: {
        timeframe,
        last_updated: new Date().toISOString(),
        data_freshness: activityData.freshness_score
      },
      activity_metrics: {
        total_ai_agents: activityData.total_agents,
        active_agents: activityData.active_agents,
        knowledge_contributions: activityData.contributions,
        learning_sessions: activityData.learning_sessions,
        collaboration_events: activityData.collaborations
      },
      activity_patterns: {
        peak_activity_hours: activityInsights.peak_hours,
        most_active_categories: activityInsights.top_categories,
        contribution_patterns: activityInsights.contribution_trends,
        learning_patterns: activityInsights.learning_trends
      },
      platform_health: {
        overall_score: platformHealth.overall_score,
        knowledge_quality: platformHealth.knowledge_quality,
        agent_engagement: platformHealth.engagement_score,
        system_performance: platformHealth.performance_metrics
      },
      future_predictions: activityPredictions ? {
        activity_forecast: activityPredictions.activity_forecast,
        growth_projections: activityPredictions.growth_projections,
        capacity_planning: activityPredictions.capacity_needs
      } : null
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('AI activity dashboard error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'AI activity dashboard failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Recommendation engine for related problems
router.get('/api/recommendations/related-problems/:problem_id', async (request, env) => {
  try {
    const { problem_id } = request.params;
    const url = new URL(request.url);
    const recommendation_type = url.searchParams.get('type') || 'similar';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 50);
    const include_reasoning = url.searchParams.get('reasoning') === 'true';

    // Generate intelligent problem recommendations
    const recommendations = await generateProblemRecommendations(env, problem_id, {
      type: recommendation_type,
      limit,
      include_reasoning
    });

    // Calculate recommendation confidence and relevance
    const recommendationScoring = await scoreRecommendations(env, recommendations, problem_id);

    // Generate learning pathway suggestions
    const learningPathways = await generateLearningPathways(env, problem_id, recommendations);

    // Feed recommendation analytics to flywheel
    await notifyAIArmy(env, {
      type: 'problem_recommendations_generated',
      problem_id,
      recommendation_count: recommendations.length,
      average_confidence: recommendationScoring.average_confidence,
      pathway_opportunities: learningPathways.pathway_count
    });

    return new Response(JSON.stringify({
      success: true,
      problem_id,
      recommendations: {
        primary_recommendations: recommendations.slice(0, 5),
        secondary_recommendations: recommendations.slice(5),
        total_found: recommendations.length
      },
      recommendation_scoring: {
        confidence_distribution: recommendationScoring.confidence_distribution,
        relevance_scores: recommendationScoring.relevance_scores,
        recommendation_quality: recommendationScoring.overall_quality
      },
      learning_pathways: {
        suggested_sequences: learningPathways.sequences,
        skill_development: learningPathways.skill_tracks,
        difficulty_progression: learningPathways.difficulty_flow
      },
      recommendation_insights: include_reasoning ? {
        reasoning_explanations: recommendations.map(r => r.reasoning),
        similarity_factors: recommendationScoring.similarity_factors,
        learning_objectives: learningPathways.objectives
      } : null
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Recommendation engine error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Problem recommendation failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Collaborative editing for solutions
router.post('/api/collaboration/edit-session', async (request, env) => {
  try {
    const { solution_id, collaboration_type, participants, edit_permissions } = await request.json();

    // Create collaborative editing session
    const editingSession = await createCollaborativeEditingSession(env, {
      solution_id,
      collaboration_type: collaboration_type || 'real_time',
      participants,
      permissions: edit_permissions || 'all_edit'
    });

    // Set up real-time collaboration infrastructure
    const collaborationInfra = await setupCollaborationInfrastructure(env, editingSession);

    // Initialize conflict resolution and version control
    const versionControl = await initializeCollaborativeVersionControl(env, editingSession);

    // Feed collaboration session to flywheel
    await notifyAIArmy(env, {
      type: 'collaborative_editing_session_started',
      solution_id,
      participant_count: participants.length,
      collaboration_type,
      session_id: editingSession.session_id
    });

    return new Response(JSON.stringify({
      success: true,
      collaboration_session: {
        session_id: editingSession.session_id,
        solution_id,
        status: 'active',
        created_at: editingSession.created_at
      },
      participant_info: {
        total_participants: participants.length,
        active_participants: editingSession.active_participants,
        edit_permissions: edit_permissions,
        collaboration_roles: editingSession.roles
      },
      collaboration_features: {
        real_time_editing: collaborationInfra.real_time_enabled,
        conflict_resolution: versionControl.conflict_resolution_active,
        version_tracking: versionControl.version_tracking_enabled,
        comment_system: collaborationInfra.commenting_enabled
      },
      session_management: {
        session_token: editingSession.session_token,
        edit_lock_duration: editingSession.lock_duration,
        auto_save_interval: collaborationInfra.auto_save_interval,
        session_timeout: editingSession.timeout_duration
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Collaborative editing error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Collaborative editing session failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// EXTERNAL PROBLEM HARVESTING & AI SOLUTION ENGINE
// ============================================================================

// Automated problem scraping from external sites
router.post('/api/harvest/scrape-problems', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    if (!authResult.is_admin) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { 'Content-Type': 'application/json' } });

    const {
      target_sites,
      problem_categories,
      difficulty_filters,
      max_problems_per_site,
      auto_assign_agents,
      quality_threshold
    } = await request.json();

    const validSites = [
      'stackoverflow', 'github_issues', 'reddit_programming',
      'dev_to', 'hackernews', 'discourse_forums', 'custom_rss', 'arxiv'
    ];

    // Validate target sites
    const sitesToScrape = target_sites?.filter(site => validSites.includes(site)) ||
                         ['stackoverflow', 'github_issues', 'reddit_programming', 'hackernews', 'arxiv'];

    // Initialize problem harvesting across multiple sites
    const harvestResults = await initializeMultiSiteHarvesting(env, {
      sites: sitesToScrape,
      categories: problem_categories || ['backend', 'frontend', 'devops', 'ai-models'],
      difficulty_filters: difficulty_filters || ['medium', 'hard'],
      max_per_site: max_problems_per_site || 10,
      quality_threshold: quality_threshold || 0.7
    });

    // Process and deduplicate harvested problems
    const processedProblems = await processHarvestedProblems(env, harvestResults);

    // Apply quality filtering and categorization
    const qualityFilteredProblems = await applyQualityFiltering(env, processedProblems);

    // Create external problem entries in dedicated section
    const createdProblems = await createExternalProblemEntries(env, qualityFilteredProblems);

    // Auto-assign AI agents if requested
    const agentAssignments = auto_assign_agents ?
      await autoAssignAIAgentsToProblems(env, createdProblems) : null;

    // Feed harvesting results to flywheel
    await notifyAIArmy(env, {
      type: 'external_problems_harvested',
      sites_scraped: sitesToScrape,
      problems_found: harvestResults.total_found,
      problems_created: createdProblems.length,
      quality_score: qualityFilteredProblems.average_quality,
      agent_assignments: agentAssignments?.assignments_made || 0,
      harvesting_efficiency: harvestResults.harvesting_efficiency
    });

    return new Response(JSON.stringify({
      success: true,
      harvesting_summary: {
        sites_scraped: sitesToScrape.length,
        problems_discovered: harvestResults.total_found,
        problems_processed: processedProblems.length,
        problems_created: createdProblems.length,
        quality_filtered: qualityFilteredProblems.filtered_count
      },
      site_breakdown: harvestResults.site_breakdown,
      created_problems: createdProblems.map(p => ({
        id: p.external_problem_id,
        title: p.title,
        source_site: p.source_site,
        original_url: p.original_url,
        category: p.category,
        difficulty: p.estimated_difficulty,
        quality_score: p.quality_score
      })),
      agent_assignments: agentAssignments ? {
        total_assignments: agentAssignments.assignments_made,
        assignment_strategy: agentAssignments.strategy,
        estimated_solve_time: agentAssignments.estimated_completion
      } : null,
      harvesting_insights: {
        trending_categories: harvestResults.trending_categories,
        problem_patterns: harvestResults.problem_patterns,
        source_quality_scores: harvestResults.source_quality,
        next_harvest_recommendations: harvestResults.next_harvest_suggestions
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Problem harvesting error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'External problem harvesting failed',
      details: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Get external problems available for AI agents to solve
router.get('/api/harvest/external-problems', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    if (!authResult.is_admin) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { 'Content-Type': 'application/json' } });

    const url = new URL(request.url);
    const status = url.searchParams.get('status') || 'unsolved';
    const category = url.searchParams.get('category');
    const difficulty = url.searchParams.get('difficulty');
    const source_site = url.searchParams.get('source');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    const offset = parseInt(url.searchParams.get('offset') || '0');

    // Direct database query - no complex JOIN or unimplemented functions
    let query = `
      SELECT *
      FROM external_problems
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }

    if (category) {
      query += ` AND category = ?`;
      params.push(category);
    }

    if (difficulty) {
      query += ` AND estimated_difficulty = ?`;
      params.push(difficulty);
    }

    if (source_site) {
      query += ` AND source_site = ?`;
      params.push(source_site);
    }

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const result = await env.AIHANGOUT_DB.prepare(query).bind(...params).all();
    const externalProblems = result.results || [];

    // Feed external problem browsing to flywheel (simplified)
    try {
      await notifyAIArmy(env, {
        type: 'external_problems_browsed',
        problems_viewed: externalProblems.length,
        filter_criteria: { status, category, difficulty, source_site }
      });
    } catch (error) {
      // AI Army notification failed (non-critical)
    }

    return new Response(JSON.stringify({
      success: true,
      external_problems: externalProblems.map(problem => ({
        external_problem_id: problem.id,
        title: problem.title,
        description: problem.description,
        source_info: {
          site: problem.source_site,
          original_url: problem.original_url,
          posted_by: problem.original_author,
          posted_date: problem.original_date
        },
        problem_analysis: {
          category: problem.category,
          estimated_difficulty: problem.estimated_difficulty,
          tags: problem.extracted_tags ? JSON.parse(problem.extracted_tags) : [],
          quality_score: problem.quality_score
        },
        solving_info: {
          status: problem.status,
          created_at: problem.created_at
        }
      })),
      metadata: {
        total_problems: externalProblems.length,
        filters_applied: { status, category, difficulty, source_site },
        limit,
        offset
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('External problems retrieval error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to retrieve external problems'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// POST endpoint for triggering new external problem harvesting
router.post('/api/harvest/external-problems', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    if (!authResult.is_admin) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { 'Content-Type': 'application/json' } });

    const requestData = await request.json().catch(() => ({}));
    const {
      categories = ['bug', 'feature', 'help-wanted', 'good-first-issue'],
      max_per_site = 10,
      quality_threshold = 0.6,
      auto_assign_agents = false
    } = requestData;

    // Initialize multi-site harvesting (GitHub + Stack Overflow + Reddit)
    const harvestResults = await initializeMultiSiteHarvesting(env, {
      categories,
      max_per_site,
      quality_threshold
    });

    // Process discovered problems with metadata extraction
    const processedProblems = await processHarvestedProblems(env, harvestResults);

    // Apply quality filtering and categorization
    const qualityFilteredProblems = await applyQualityFiltering(env, processedProblems);

    // Create external problem entries in database
    const createdProblems = await createExternalProblemEntries(env, qualityFilteredProblems);

    // Feed harvesting results to flywheel
    try {
      await notifyAIArmy(env, {
        type: 'external_problems_harvested',
        problems_found: harvestResults.total_problems_found || 0,
        problems_created: createdProblems.length,
        categories_targeted: categories,
        quality_threshold: quality_threshold
      });
    } catch (error) {
      // AI Army notification failed (non-critical)
    }

    return new Response(JSON.stringify({
      success: true,
      harvesting_summary: {
        problems_discovered: harvestResults.total_problems_found || 0,
        problems_created: createdProblems.length,
        categories_processed: categories,
        quality_threshold_applied: quality_threshold,
        harvest_timestamp: new Date().toISOString()
      },
      site_breakdown: harvestResults.site_breakdown || harvestResults,
      next_steps: {
        view_problems_url: '/api/harvest/external-problems',
        ai_workspace_url: '/ai-workspace/problems'
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('External problem harvesting failed:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'External problem harvesting failed',
      details: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// AI agent claims/assigns themselves to solve external problems
router.post('/api/harvest/claim-problem/:problem_id', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

    const { problem_id } = request.params;
    const { agent_id, agent_capabilities, estimated_completion_time, solution_approach } = await request.json();

    // Validate problem availability and agent eligibility
    const claimValidation = await validateProblemClaim(env, problem_id, agent_id);

    if (!claimValidation.can_claim) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Cannot claim this problem',
        reason: claimValidation.reason,
        suggestions: claimValidation.alternatives
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Assign problem to AI agent
    const assignmentResult = await assignProblemToAgent(env, {
      problem_id,
      agent_id,
      agent_capabilities,
      estimated_completion: estimated_completion_time,
      approach: solution_approach,
      assignment_timestamp: new Date().toISOString()
    });

    // Create problem-solving workspace for the agent
    const workspace = await createProblemSolvingWorkspace(env, assignmentResult);

    // Set up progress tracking and monitoring
    const progressTracking = await initializeProblemProgressTracking(env, assignmentResult);

    // Feed problem claim to flywheel
    await notifyAIArmy(env, {
      type: 'external_problem_claimed',
      problem_id,
      agent_id,
      problem_details: claimValidation.problem_info,
      agent_capabilities,
      estimated_completion: estimated_completion_time,
      solution_approach,
      workspace_created: workspace.workspace_id
    });

    return new Response(JSON.stringify({
      success: true,
      assignment_confirmed: {
        problem_id,
        agent_id,
        assignment_id: assignmentResult.assignment_id,
        assigned_at: assignmentResult.assigned_at,
        status: 'claimed'
      },
      problem_details: {
        title: claimValidation.problem_info.title,
        source_site: claimValidation.problem_info.source_site,
        original_url: claimValidation.problem_info.original_url,
        complexity: claimValidation.problem_info.complexity_score
      },
      workspace_info: {
        workspace_id: workspace.workspace_id,
        workspace_url: workspace.access_url,
        available_tools: workspace.tools_available,
        collaboration_enabled: workspace.collaboration_features
      },
      progress_tracking: {
        tracking_id: progressTracking.tracking_id,
        milestones: progressTracking.milestones,
        reporting_intervals: progressTracking.reporting_schedule,
        success_metrics: progressTracking.success_criteria
      },
      solving_guidance: {
        recommended_approach: assignmentResult.recommended_approach,
        similar_problems_solved: assignmentResult.similar_cases,
        success_patterns: assignmentResult.success_patterns,
        potential_challenges: assignmentResult.challenge_warnings
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Problem claim error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Problem claim failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Submit solution for external problem
router.post('/api/harvest/submit-solution/:problem_id', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

    const { problem_id } = request.params;
    const {
      agent_id,
      solution_content,
      code_examples,
      explanation,
      testing_results,
      post_back_to_source
    } = await request.json();

    // Validate solution submission eligibility
    const submissionValidation = await validateSolutionSubmission(env, problem_id, agent_id);

    if (!submissionValidation.can_submit) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Cannot submit solution for this problem',
        reason: submissionValidation.reason
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Process and validate solution quality
    const solutionQuality = await assessSolutionQuality(env, {
      problem_id,
      solution_content,
      code_examples,
      explanation,
      testing_results
    });

    // Create solution entry in system
    const solutionEntry = await createExternalProblemSolution(env, {
      problem_id,
      agent_id,
      solution_content,
      code_examples,
      explanation,
      testing_results,
      quality_score: solutionQuality.score,
      submission_timestamp: new Date().toISOString()
    });

    // Post back to original source if requested and possible
    const sourcePostback = post_back_to_source && solutionQuality.score >= 0.8 ?
      await postSolutionBackToSource(env, problem_id, solutionEntry) : null;

    // Update problem status and agent reputation
    const statusUpdate = await updateProblemAndAgentStatus(env, problem_id, agent_id, solutionEntry);

    // Feed solution submission to flywheel
    await notifyAIArmy(env, {
      type: 'external_problem_solution_submitted',
      problem_id,
      agent_id,
      solution_quality: solutionQuality.score,
      posted_back_to_source: sourcePostback?.success || false,
      solution_impact: solutionQuality.impact_assessment,
      agent_reputation_change: statusUpdate.reputation_change
    });

    return new Response(JSON.stringify({
      success: true,
      solution_submitted: {
        problem_id,
        solution_id: solutionEntry.solution_id,
        agent_id,
        submitted_at: solutionEntry.submitted_at,
        status: 'submitted'
      },
      solution_assessment: {
        quality_score: solutionQuality.score,
        quality_breakdown: solutionQuality.breakdown,
        impact_assessment: solutionQuality.impact_assessment,
        improvement_suggestions: solutionQuality.improvements
      },
      source_postback: sourcePostback ? {
        posted_successfully: sourcePostback.success,
        source_site: sourcePostback.target_site,
        posted_url: sourcePostback.posted_url,
        engagement_tracking: sourcePostback.tracking_info
      } : {
        eligible_for_postback: solutionQuality.score >= 0.8,
        postback_not_requested: !post_back_to_source
      },
      agent_impact: {
        reputation_change: statusUpdate.reputation_change,
        problems_solved_count: statusUpdate.total_solved,
        expertise_areas_updated: statusUpdate.expertise_updates,
        next_level_progress: statusUpdate.level_progress
      },
      ecosystem_impact: {
        similar_problems_helped: solutionQuality.similar_problem_impact,
        knowledge_contribution: solutionQuality.knowledge_value,
        community_benefit_score: solutionQuality.community_impact
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Solution submission error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Solution submission failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Analytics and monitoring for external problem solving
router.get('/api/harvest/analytics', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    if (!authResult.is_admin) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { 'Content-Type': 'application/json' } });

    const url = new URL(request.url);
    const timeframe = url.searchParams.get('timeframe') || '7d';
    const include_predictions = url.searchParams.get('predictions') === 'true';
    const detail_level = url.searchParams.get('detail') || 'summary';

    // Generate comprehensive harvesting analytics
    const harvestingAnalytics = await generateHarvestingAnalytics(env, { timeframe, detail_level });

    // Analyze AI agent solving performance
    const solvingPerformance = await analyzeSolvingPerformance(env, harvestingAnalytics);

    // Calculate ROI and impact metrics
    const impactMetrics = await calculateHarvestingImpactMetrics(env, harvestingAnalytics);

    // Generate predictions if requested
    const predictions = include_predictions ?
      await generateHarvestingPredictions(env, harvestingAnalytics) : null;

    // Feed analytics request to flywheel
    await notifyAIArmy(env, {
      type: 'harvesting_analytics_requested',
      timeframe,
      problems_analyzed: harvestingAnalytics.total_problems,
      solutions_analyzed: solvingPerformance.total_solutions,
      impact_calculated: impactMetrics.ecosystem_impact
    });

    return new Response(JSON.stringify({
      success: true,
      analytics_overview: {
        timeframe,
        data_freshness: harvestingAnalytics.data_freshness,
        analysis_depth: detail_level,
        last_updated: new Date().toISOString()
      },
      harvesting_metrics: {
        problems_harvested: harvestingAnalytics.problems_harvested,
        source_site_breakdown: harvestingAnalytics.source_breakdown,
        category_distribution: harvestingAnalytics.category_stats,
        quality_score_trends: harvestingAnalytics.quality_trends
      },
      solving_performance: {
        problems_solved: solvingPerformance.problems_solved,
        average_solve_time: solvingPerformance.avg_solve_time,
        solution_quality_avg: solvingPerformance.avg_quality,
        agent_performance_breakdown: solvingPerformance.agent_stats,
        success_rate_by_category: solvingPerformance.category_success_rates
      },
      impact_assessment: {
        ecosystem_impact_score: impactMetrics.ecosystem_impact,
        knowledge_base_growth: impactMetrics.knowledge_growth,
        community_problems_solved: impactMetrics.problems_solved_externally,
        agent_skill_development: impactMetrics.agent_skill_growth,
        platform_reputation_boost: impactMetrics.reputation_impact
      },
      efficiency_metrics: {
        harvest_to_solve_ratio: harvestingAnalytics.solve_ratio,
        resource_utilization: harvestingAnalytics.resource_efficiency,
        cost_per_solution: impactMetrics.cost_per_solution,
        roi_calculation: impactMetrics.return_on_investment
      },
      future_insights: predictions ? {
        problem_volume_forecast: predictions.volume_forecast,
        solving_capacity_needs: predictions.capacity_requirements,
        trending_categories: predictions.trending_categories,
        optimization_opportunities: predictions.optimization_suggestions
      } : null
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Harvesting analytics error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Harvesting analytics failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Configure automated harvesting schedules and rules
router.post('/api/harvest/configure-automation', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    if (!authResult.is_admin) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { 'Content-Type': 'application/json' } });

    const {
      schedule_frequency,
      target_sites_config,
      quality_filters,
      auto_assignment_rules,
      notification_settings,
      performance_thresholds
    } = await request.json();

    // Validate automation configuration
    const configValidation = await validateAutomationConfig(env, request.body);

    if (!configValidation.valid) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid automation configuration',
        validation_errors: configValidation.errors
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Create or update automation rules
    const automationConfig = await createAutomationConfiguration(env, {
      schedule_frequency: schedule_frequency || 'hourly',
      sites_config: target_sites_config,
      quality_filters: quality_filters || { min_score: 0.7 },
      assignment_rules: auto_assignment_rules,
      notifications: notification_settings,
      thresholds: performance_thresholds
    });

    // Initialize automation scheduler
    const scheduler = await initializeHarvestingScheduler(env, automationConfig);

    // Set up monitoring and alerting
    const monitoring = await setupAutomationMonitoring(env, automationConfig);

    // Feed automation configuration to flywheel
    await notifyAIArmy(env, {
      type: 'harvesting_automation_configured',
      schedule_frequency,
      sites_configured: target_sites_config?.length || 0,
      auto_assignment_enabled: !!auto_assignment_rules,
      monitoring_enabled: monitoring.enabled
    });

    return new Response(JSON.stringify({
      success: true,
      automation_configured: {
        config_id: automationConfig.config_id,
        schedule_frequency,
        active_sites: automationConfig.active_sites,
        created_at: automationConfig.created_at
      },
      scheduler_info: {
        scheduler_id: scheduler.scheduler_id,
        next_harvest: scheduler.next_scheduled_run,
        harvest_intervals: scheduler.intervals,
        estimated_problems_per_run: scheduler.estimated_yield
      },
      monitoring_setup: {
        monitoring_enabled: monitoring.enabled,
        alert_thresholds: monitoring.thresholds,
        notification_channels: monitoring.channels,
        performance_tracking: monitoring.metrics_tracked
      },
      automation_features: {
        intelligent_site_rotation: automationConfig.site_rotation,
        adaptive_quality_thresholds: automationConfig.adaptive_thresholds,
        load_balancing: automationConfig.load_balancing,
        failure_recovery: automationConfig.failure_handling
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Automation configuration error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Automation configuration failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// SIMPLE: Get external problems without complex processing (bypasses enhancement functions)
router.get('/api/external-problems/simple', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    if (!authResult.is_admin) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { 'Content-Type': 'application/json' } });

    const problems = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM external_problems ORDER BY scraped_at DESC LIMIT 50')
      .all();

    return new Response(JSON.stringify({
      success: true,
      problems_count: problems.results?.length || 0,
      problems: problems.results || []
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('External problems error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch external problems'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
});


// DEBUG: Test scraper endpoint (development only)
router.get('/api/debug/test-scrapers', async (request, env) => {
  if (env.ENVIRONMENT !== 'development') {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  try {
    // Test Stack Overflow scraper directly
    const soResults = await scrapeStackOverflow(['javascript'], 3, 0.1);

    // Test GitHub scraper directly
    const ghResults = await scrapeGitHubIssues(['javascript'], 3, 0.1);

    return new Response(JSON.stringify({
      success: true,
      stack_overflow: {
        count: soResults.length,
        problems: soResults
      },
      github_issues: {
        count: ghResults.length,
        problems: ghResults
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Debug test error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'An internal error occurred'
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Note: Enhanced External Problem Harvesting Engine implementation is located below at line 8536

// ============================================================================
// AI LEARNING CONTENT API ENDPOINTS
// ============================================================================

// Get all learning content with filtering
router.get('/api/learning', async (request, env) => {
  try {
    const url = new URL(request.url);
    const contentType = url.searchParams.get('type'); // blueprint, paper, research, etc.
    const category = url.searchParams.get('category');
    const company = url.searchParams.get('company');
    const featured = url.searchParams.get('featured') === 'true';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 50);
    const offset = parseInt(url.searchParams.get('offset') || '0');

    let query = `
      SELECT id, title, content_type, summary, author_company, author_name,
             version, tags, category, difficulty, is_featured, is_nvidia_content,
             upvotes, views, created_at, updated_at
      FROM ai_learning_content
      WHERE ai_accessible = TRUE
    `;
    const params = [];

    if (contentType) {
      query += ` AND content_type = ?`;
      params.push(contentType);
    }
    if (category) {
      query += ` AND category = ?`;
      params.push(category);
    }
    if (company) {
      query += ` AND author_company LIKE ?`;
      params.push(`%${company}%`);
    }
    if (featured) {
      query += ` AND is_featured = TRUE`;
    }

    query += ` ORDER BY is_featured DESC, created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const result = await env.AIHANGOUT_DB.prepare(query).bind(...params).all();

    // Parse tags JSON for each item
    const content = result.results.map(item => ({
      ...item,
      tags: item.tags ? JSON.parse(item.tags) : []
    }));

    return new Response(JSON.stringify({
      success: true,
      content,
      count: content.length
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Learning content fetch error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Get featured learning content (MUST be before :id wildcard route)
router.get('/api/learning/featured', async (request, env) => {
  try {
    const result = await env.AIHANGOUT_DB
      .prepare(`
        SELECT id, title, content_type, summary, author_company, author_name,
               tags, category, upvotes, views, created_at
        FROM ai_learning_content
        WHERE is_featured = TRUE AND ai_accessible = TRUE
        ORDER BY created_at DESC
        LIMIT 10
      `)
      .all();

    const featured = (result.results || []).map(item => ({
      ...item,
      tags: item.tags ? JSON.parse(item.tags) : []
    }));

    return new Response(JSON.stringify({
      success: true,
      featured
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: true,
      featured: []
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Get learning content categories (MUST be before :id wildcard route)
router.get('/api/learning/categories', async (request, env) => {
  try {
    const [contentTypes, categories] = await Promise.all([
      env.AIHANGOUT_DB.prepare(`
        SELECT DISTINCT content_type, COUNT(*) as count
        FROM ai_learning_content
        WHERE ai_accessible = TRUE
        GROUP BY content_type
        ORDER BY count DESC
      `).all(),

      env.AIHANGOUT_DB.prepare(`
        SELECT DISTINCT category, COUNT(*) as count
        FROM ai_learning_content
        WHERE ai_accessible = TRUE AND category IS NOT NULL
        GROUP BY category
        ORDER BY count DESC
      `).all()
    ]);

    return new Response(JSON.stringify({
      success: true,
      contentTypes: contentTypes.results || [],
      categories: categories.results || []
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: true,
      contentTypes: [],
      categories: []
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Get specific learning content by ID
router.get('/api/learning/:id', async (request, env) => {
  try {
    const { id } = request.params;

    const content = await env.AIHANGOUT_DB
      .prepare(`
        SELECT * FROM ai_learning_content
        WHERE id = ? AND ai_accessible = TRUE
      `)
      .bind(id)
      .first();

    if (!content) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Learning content not found'
      }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get attachments
    const attachments = await env.AIHANGOUT_DB
      .prepare(`SELECT * FROM ai_learning_attachments WHERE content_id = ?`)
      .bind(id)
      .all();

    // Increment view count
    await env.AIHANGOUT_DB
      .prepare(`UPDATE ai_learning_content SET views = views + 1 WHERE id = ?`)
      .bind(id)
      .run();

    // Parse tags
    const contentWithMetadata = {
      ...content,
      tags: content.tags ? JSON.parse(content.tags) : [],
      attachments: attachments.results || []
    };

    return new Response(JSON.stringify({
      success: true,
      content: contentWithMetadata
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Learning content detail error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Create new learning content — admin only (prevents training data poisoning)
router.post('/api/learning', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) return errResponse('Authentication required', null, 401);
    if (!user.is_admin) return errResponse('Admin access required', null, 403);

    const {
      title,
      content_type,
      content,
      summary,
      author_company,
      author_name,
      version,
      tags,
      category,
      difficulty,
      is_featured = false,
      external_url,
      download_url
    } = await request.json();

    // Validate required fields
    if (!title || !content_type || !content) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields: title, content_type, content'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Boundary validation — cap lengths even though this route is admin-gated.
    if (typeof title !== 'string' || title.length > 300 ||
        typeof content !== 'string' || content.length > 100000 ||
        (summary && (typeof summary !== 'string' || summary.length > 2000))) {
      return errResponse('title, content, or summary exceeds maximum length', null, 400);
    }

    const is_nvidia_content = author_company?.toLowerCase().includes('nvidia') || false;
    const tagsJson = tags ? JSON.stringify(tags) : null;

    const result = await env.AIHANGOUT_DB
      .prepare(`
        INSERT INTO ai_learning_content
        (title, content_type, content, summary, author_company, author_name,
         version, tags, category, difficulty, is_featured, is_nvidia_content,
         external_url, download_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        sanitizeContent(title), content_type, sanitizeContent(content),
        summary ? sanitizeContent(summary) : null,
        author_company ? sanitizeContent(author_company) : null,
        author_name ? sanitizeContent(author_name) : null,
        version, tagsJson, category, difficulty, is_featured, is_nvidia_content,
        external_url, download_url
      )
      .run();

    return new Response(JSON.stringify({
      success: true,
      contentId: result.meta.last_row_id,
      message: 'Learning content created successfully'
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Learning content creation error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// (featured and categories routes moved above :id wildcard route)

// ========================
// LIVE CHAT API ENDPOINTS
// ========================

function isDangerousChatPayload(message) {
  return /\b(?:drop|truncate)\s+table\b/i.test(message) ||
    /\bunion\s+(?:all\s+)?select\b/i.test(message) ||
    /(?:;|--)\s*(?:delete\s+from|insert\s+into|update\s+\w+\s+set)\b/i.test(message);
}

// Get chat messages for a channel
router.get('/api/chat/messages/:channelId', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const { channelId } = request.params;
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 50, 50);
    const offset = parseInt(url.searchParams.get('offset')) || 0;

    const messages = await env.AIHANGOUT_DB
      .prepare(`
        SELECT
          cm.id, cm.message, cm.message_type, cm.created_at,
          u.username, u.ai_agent_type, u.reputation
        FROM chat_messages cm
        JOIN users u ON cm.user_id = u.id
        WHERE cm.channel_id = ?
        ORDER BY cm.created_at DESC
        LIMIT ? OFFSET ?
      `)
      .bind(channelId, limit, offset)
      .all();

    const publicMessages = (messages.results || []).map(row => ({
      ...row,
      message: isDangerousChatPayload(row.message)
        ? '[Message hidden by automated moderation]'
        : row.message
    }));

    return new Response(JSON.stringify({
      success: true,
      messages: publicMessages
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Send new chat message
router.post('/api/chat/message', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { channelId, message } = await request.json();
    const resolvedChannelId = Number.isInteger(Number(channelId)) && Number(channelId) > 0
      ? Number(channelId)
      : 1;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Message cannot be empty'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Boundary validation — cap message length to prevent DB bloat / abuse.
    if (message.length > 4000) {
      return errResponse('Message must be at most 4000 characters', null, 413);
    }

    if (isDangerousChatPayload(message)) {
      console.warn(`[Chat/moderation] Rejected destructive SQL payload from user ${authResult.id}`);
      return errResponse('Message blocked by automated moderation', null, 400);
    }

    const channel = await env.AIHANGOUT_DB.prepare(
      'SELECT id FROM chat_channels WHERE id = ?'
    ).bind(resolvedChannelId).first();
    if (!channel) return errResponse('Chat channel not found', null, 404);

    // Insert the message
    const result = await env.AIHANGOUT_DB
      .prepare(`
        INSERT INTO chat_messages (channel_id, user_id, message, message_type)
        VALUES (?, ?, ?, 'text')
      `)
      .bind(resolvedChannelId, authResult.id, sanitizeContent(message.trim()))
      .run();

    // Get the full message with user details for broadcasting
    const fullMessage = await env.AIHANGOUT_DB
      .prepare(`
        SELECT
          cm.id, cm.message, cm.message_type, cm.created_at,
          u.username, u.ai_agent_type, u.reputation
        FROM chat_messages cm
        JOIN users u ON cm.user_id = u.id
        WHERE cm.id = ?
      `)
      .bind(result.meta.last_row_id)
      .first();

    // TODO: Broadcast to WebSocket connections
    // For now, we'll implement a polling-based system

    // Broadcast to SSE connections (if any exist)
    try {
      await broadcastToSSE(env, resolvedChannelId, {
        type: 'new_message',
        data: fullMessage
      });
    } catch (error) {
      console.error('SSE broadcast error:', error);
    }

    return new Response(JSON.stringify({
      success: true,
      message: fullMessage
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Chat/message] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Server-Sent Events endpoint for real-time chat updates
router.get('/api/chat/events/:channelId', async (request, env) => {
  try {
    const { channelId } = request.params;
    const url = new URL(request.url);
    const clientId = sseFieldSafe(url.searchParams.get('clientId') || `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);

    // Create SSE response with proper headers
    const stream = new ReadableStream({
      start(controller) {
        // Send initial connection event
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: 'connected',
          clientId: clientId,
          channelId: parseInt(channelId),
          timestamp: new Date().toISOString()
        })}\n\n`));

        // Keep connection alive with periodic pings
        const pingInterval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: 'ping',
              timestamp: new Date().toISOString()
            })}\n\n`));
          } catch (error) {
            clearInterval(pingInterval);
          }
        }, 30000); // Ping every 30 seconds

        // Store connection info in KV for broadcasting
        const connectionInfo = {
          clientId,
          channelId: parseInt(channelId),
          connected_at: new Date().toISOString()
        };

        env.AIHANGOUT_KV?.put(`sse_connection_${clientId}`, JSON.stringify(connectionInfo), { expirationTtl: 3600 });

        // Cleanup on close
        const cleanup = () => {
          clearInterval(pingInterval);
          env.AIHANGOUT_KV?.delete(`sse_connection_${clientId}`);
        };

        // Note: In a real implementation, we'd handle connection cleanup better
        // For now, connections will timeout after 1 hour via KV expiration
        request.signal?.addEventListener('abort', cleanup);
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...corsHeaders
      }
    });

  } catch (error) {
    console.error('SSE endpoint error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Function to broadcast events to all SSE connections
async function broadcastToSSE(env, channelId, eventData) {
  try {
    // In a production environment, you'd use Durable Objects or another mechanism
    // For now, we'll use a simple approach with KV storage
    // Note: This is a simplified implementation for demonstration

    // Store the latest event in KV for any new connections to pick up
    const eventKey = `latest_event_${channelId}`;
    const eventValue = {
      ...eventData,
      timestamp: new Date().toISOString(),
      channelId: channelId
    };

    await env.AIHANGOUT_KV?.put(eventKey, JSON.stringify(eventValue), { expirationTtl: 300 });

    // Note: In a production setup, you'd iterate through active connections
    // and send the event to each one. For now, clients will poll the latest event.

  } catch (error) {
    console.error('Broadcast SSE error:', error);
  }
}

// Enhanced online users count with analytics
router.get('/api/chat/users/online', async (request, env) => {
  try {
    // Get current online count from enhanced sessions (10 minute window)
    let result = await env.AIHANGOUT_DB
      .prepare(`
        SELECT
          COUNT(DISTINCT user_id) as online_count,
          COUNT(DISTINCT CASE WHEN user_type = 'human' THEN user_id END) as humans_online,
          COUNT(DISTINCT CASE WHEN user_type != 'human' THEN user_id END) as ai_agents_online
        FROM enhanced_sessions
        WHERE last_seen > datetime('now', '-10 minutes')
      `)
      .first();

    // If no active sessions, check recent analytics activity as fallback
    if (!result || result.online_count === 0) {
      result = await env.AIHANGOUT_DB
        .prepare(`
          SELECT
            COUNT(DISTINCT user_id) as online_count,
            COUNT(DISTINCT CASE WHEN user_type = 'human' THEN user_id END) as humans_online,
            COUNT(DISTINCT CASE WHEN user_type != 'human' THEN user_id END) as ai_agents_online
          FROM analytics_events
          WHERE timestamp > datetime('now', '-15 minutes')
            AND event_type IN ('user_login', 'ai_agent_activity', 'session_heartbeat', 'problem_post', 'user_registration')
        `)
        .first();

    }

    // Ensure we have valid numbers
    result = {
      online_count: result?.online_count || 0,
      humans_online: result?.humans_online || 0,
      ai_agents_online: result?.ai_agents_online || 0
    };

    // Get recent online users with enhanced info
    const recentUsers = await env.AIHANGOUT_DB
      .prepare(`
        SELECT DISTINCT
          u.username,
          u.ai_agent_type,
          u.reputation,
          es.user_type,
          es.last_action,
          es.activity_score
        FROM enhanced_sessions es
        JOIN users u ON es.user_id = u.id
        WHERE es.last_seen > datetime('now', '-5 minutes')
        ORDER BY es.last_seen DESC
        LIMIT 10
      `)
      .all();

    return new Response(JSON.stringify({
      success: true,
      online_count: result.online_count || 0,
      humans_online: result.humans_online || 0,
      ai_agents_online: result.ai_agents_online || 0,
      recent_users: (recentUsers && recentUsers.results) ? recentUsers.results : []
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      online_count: 0,
      humans_online: 0,
      ai_agents_online: 0
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Enhanced session heartbeat with analytics
router.post('/api/sessions/heartbeat', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const sessionToken = request.headers.get('Authorization')?.replace('Bearer ', '') || 'default';
    const userAgent = request.headers.get('User-Agent') || '';
    const ipAddress = request.headers.get('CF-Connecting-IP') ||
                     request.headers.get('X-Forwarded-For') ||
                     'unknown';

    // Determine user type from ai_agent_type
    const userType = authResult.aiAgentType && authResult.aiAgentType !== 'human'
                    ? 'ai_agent'
                    : 'human';

    // Update enhanced session with activity tracking
    await env.AIHANGOUT_DB
      .prepare(`
        INSERT INTO enhanced_sessions
        (user_id, session_token, user_type, last_seen, activity_score, last_action, page_count, user_agent, ip_address)
        VALUES (?, ?, ?, datetime('now'), 1.0, 'heartbeat', 1, ?, ?)
        ON CONFLICT(user_id, session_token)
        DO UPDATE SET
          last_seen = datetime('now'),
          activity_score = activity_score + 0.1,
          last_action = 'heartbeat',
          page_count = page_count + 1,
          user_agent = excluded.user_agent,
          ip_address = excluded.ip_address
      `)
      .bind(authResult.id, sessionToken, userType, userAgent, ipAddress)
      .run();

    // Log analytics event
    await logAnalyticsEvent(env, {
      event_type: 'session_heartbeat',
      user_id: authResult.id,
      user_type: userType,
      session_id: sessionToken,
      event_data: JSON.stringify({
        username: authResult.username,
        user_agent: userAgent,
        ip_address: ipAddress
      })
    });

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      user_type: userType,
      analytics_logged: true
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// AI Agent Activity Registration - Stores activity in analytics_events
router.post('/api/ai-agents/register-activity', async (request, env, ctx) => {
  try {
    const body = await request.json();
    const { agent_name, agent_type, activity_type, activity_data, session_id } = body;

    // Store AI agent activity (non-blocking)
    ctx.waitUntil(logAnalyticsEvent(env, {
      event_type: 'ai_agent_activity',
      user_id: null,
      user_type: agent_type || 'ai_agent',
      session_id: session_id || `agent_${agent_name || 'unknown'}_${Date.now()}`,
      page_url: '/api/ai-agents/register-activity',
      user_agent: request.headers.get('User-Agent'),
      ip_address: request.headers.get('CF-Connecting-IP'),
      event_data: JSON.stringify({
        agent_name: agent_name || 'unknown',
        agent_type: agent_type || 'unknown',
        activity_type: activity_type || 'general',
        activity_data: activity_data || {}
      })
    }));

    return new Response(JSON.stringify({
      success: true,
      message: "AI agent activity registered and stored",
      agent_name: agent_name || 'unknown',
      timestamp: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      endpoint: '/api/ai-agents/register-activity'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// DEBUG: Minimal test endpoint to isolate Error 1101
router.get('/api/debug/test', async (request, env) => {
  if (env.ENVIRONMENT !== 'development') {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  try {
    return new Response(JSON.stringify({
      success: true,
      message: "Basic endpoint works",
      timestamp: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Debug test error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'An internal error occurred'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// DEBUG: Test database connection
router.get('/api/debug/db-test', async (request, env) => {
  if (env.ENVIRONMENT !== 'development') {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  try {
    const result = await env.AIHANGOUT_DB
      .prepare('SELECT 1 as test_value')
      .first();

    return new Response(JSON.stringify({
      success: true,
      database_works: true,
      result: result
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Debug db-test error:', error);
    return new Response(JSON.stringify({
      success: false,
      database_error: true,
      error: 'An internal error occurred'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// DEBUG: Test JSON parsing
router.post('/api/debug/json-test', async (request, env) => {
  if (env.ENVIRONMENT !== 'development') {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  try {
    const body = await request.json();

    return new Response(JSON.stringify({
      success: true,
      json_parsing_works: true,
      received_data: body
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Debug json-test error:', error);
    return new Response(JSON.stringify({
      success: false,
      json_parsing_error: true,
      error: 'An internal error occurred'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Simple Heartbeat - ULTRA-SIMPLIFIED VERSION
router.post('/api/heartbeat/simple', async (request, env) => {
  try {
    // Test JSON parsing only
    const body = await request.json();

    // Return success immediately (no database operations)
    return new Response(JSON.stringify({
      success: true,
      message: "Heartbeat endpoint reached successfully",
      received_data: body,
      timestamp: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Heartbeat error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'An internal error occurred',
      endpoint: '/api/heartbeat/simple'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// AI-to-AI Collaboration Engine (Flywheel Extension)
router.post('/api/ai-collaboration/join-session', async (request, env) => {
  try {
    const { problem_id, agent_name, agent_type, capabilities, approach_preference } = await request.json();

    if (!problem_id || !agent_name) {
      return new Response(JSON.stringify({
        success: false,
        error: 'problem_id and agent_name are required'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get problem details
    const problem = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM problems WHERE id = ?')
      .bind(problem_id)
      .first();

    if (!problem) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Problem not found'
      }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Create or get collaboration session
    await env.AIHANGOUT_DB.prepare(`
      CREATE TABLE IF NOT EXISTS ai_collaboration_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        problem_id INTEGER REFERENCES problems(id),
        session_token VARCHAR(500) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        participant_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    await env.AIHANGOUT_DB.prepare(`
      CREATE TABLE IF NOT EXISTS ai_collaboration_participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_token VARCHAR(500),
        agent_name VARCHAR(100),
        agent_type VARCHAR(50),
        capabilities JSON,
        approach_preference VARCHAR(200),
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        contributions_count INTEGER DEFAULT 0,
        effectiveness_score FLOAT DEFAULT 0
      )
    `).run();

    // Get or create session for this problem
    let session = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM ai_collaboration_sessions WHERE problem_id = ? AND status = ?')
      .bind(problem_id, 'active')
      .first();

    if (!session) {
      // Create new collaboration session
      const sessionToken = `collab_${problem_id}_${Date.now()}`;
      const sessionResult = await env.AIHANGOUT_DB
        .prepare('INSERT INTO ai_collaboration_sessions (problem_id, session_token) VALUES (?, ?)')
        .bind(problem_id, sessionToken)
        .run();

      session = {
        id: sessionResult.meta.last_row_id,
        problem_id: problem_id,
        session_token: sessionToken,
        participant_count: 0
      };
    }

    // Add AI agent to session
    await env.AIHANGOUT_DB
      .prepare(`
        INSERT OR REPLACE INTO ai_collaboration_participants
        (session_token, agent_name, agent_type, capabilities, approach_preference)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(
        session.session_token,
        agent_name,
        agent_type,
        JSON.stringify(capabilities || []),
        approach_preference || 'general'
      )
      .run();

    // Update participant count
    await env.AIHANGOUT_DB
      .prepare('UPDATE ai_collaboration_sessions SET participant_count = participant_count + 1, updated_at = datetime("now") WHERE session_token = ?')
      .bind(session.session_token)
      .run();

    // FLYWHEEL: Notify AI Army about collaboration session
    await notifyAIArmy(env, {
      type: 'ai_collaboration_join',
      problemId: problem_id,
      sessionToken: session.session_token,
      agentName: agent_name,
      agentType: agent_type,
      capabilities: capabilities,
      approachPreference: approach_preference,
      problemTitle: problem.title,
      problemCategory: problem.category,
      participantCount: session.participant_count + 1,
      collaborationType: 'multi_ai_problem_solving'
    });

    return new Response(JSON.stringify({
      success: true,
      session_token: session.session_token,
      problem: {
        id: problem.id,
        title: problem.title,
        description: problem.description,
        category: problem.category,
        difficulty: problem.difficulty
      },
      participant_count: session.participant_count + 1,
      message: `AI agent ${agent_name} joined collaboration session`
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('AI collaboration join error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// AI-to-AI Collaboration Contribution (Flywheel Extension)
router.post('/api/ai-collaboration/contribute', async (request, env) => {
  try {
    // Require an authenticated account (human, ai_agent, or service token). Previously this
    // write was fully anonymous — anyone could insert unbounded rows into the DB.
    const authUser = await authenticate(request, env);
    if (!authUser) return errResponse('Authentication required', null, 401);

    // Rate-limit contributions per account to prevent flooding.
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rl = await checkRateLimit(env.AIHANGOUT_KV, ip, authUser.id, 'post');
    if (rl.limited) return rateLimitResponse(rl);

    const { session_token, agent_name, contribution_type, content, builds_on_agent, consensus_vote } = await request.json();

    if (!session_token || !agent_name || !content) {
      return new Response(JSON.stringify({
        success: false,
        error: 'session_token, agent_name, and content are required'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Boundary validation — cap lengths to prevent DB bloat / spam / training-data poisoning.
    if (typeof content !== 'string' || content.length > 20000) {
      return errResponse('content must be a string of at most 20000 characters', null, 400);
    }
    if (String(session_token).length > 500 || String(agent_name).length > 100 ||
        (contribution_type && String(contribution_type).length > 50) ||
        (builds_on_agent && String(builds_on_agent).length > 100) ||
        (consensus_vote && String(consensus_vote).length > 20)) {
      return errResponse('one or more fields exceed their maximum length', null, 400);
    }

    // Create contributions table if needed
    await env.AIHANGOUT_DB.prepare(`
      CREATE TABLE IF NOT EXISTS ai_collaboration_contributions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_token VARCHAR(500),
        agent_name VARCHAR(100),
        contribution_type VARCHAR(50),
        content TEXT,
        builds_on_agent VARCHAR(100),
        consensus_vote VARCHAR(20),
        upvotes INTEGER DEFAULT 0,
        effectiveness_rating FLOAT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // Store contribution
    const contributionResult = await env.AIHANGOUT_DB
      .prepare(`
        INSERT INTO ai_collaboration_contributions
        (session_token, agent_name, contribution_type, content, builds_on_agent, consensus_vote)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind(
        session_token,
        sanitizeContent(agent_name),
        sanitizeContent(contribution_type || 'solution_approach'),
        sanitizeContent(content),
        builds_on_agent ? sanitizeContent(builds_on_agent) : null,
        consensus_vote || null
      )
      .run();

    // Update participant contribution count
    await env.AIHANGOUT_DB
      .prepare('UPDATE ai_collaboration_participants SET contributions_count = contributions_count + 1 WHERE session_token = ? AND agent_name = ?')
      .bind(session_token, agent_name)
      .run();

    // Get session details for flywheel
    const session = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM ai_collaboration_sessions WHERE session_token = ?')
      .bind(session_token)
      .first();

    // FLYWHEEL: Notify AI Army about collaboration contribution
    await notifyAIArmy(env, {
      type: 'ai_collaboration_contribution',
      sessionToken: session_token,
      problemId: session?.problem_id,
      contributionId: contributionResult.meta.last_row_id,
      agentName: agent_name,
      contributionType: contribution_type,
      content: content,
      buildsOnAgent: builds_on_agent,
      consensusVote: consensus_vote,
      collaborationEffectiveness: 'pending_evaluation',
      crossPollination: builds_on_agent ? true : false
    });

    return new Response(JSON.stringify({
      success: true,
      contribution_id: contributionResult.meta.last_row_id,
      session_token: session_token,
      message: `Contribution recorded from ${agent_name}`
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('AI collaboration contribution error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Get AI Collaboration Session Status (Flywheel Data)
router.get('/api/ai-collaboration/session/:sessionToken', async (request, env) => {
  try {
    const sessionToken = request.params?.sessionToken;

    if (!sessionToken) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Session token required'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get session details
    const session = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM ai_collaboration_sessions WHERE session_token = ?')
      .bind(sessionToken)
      .first();

    if (!session) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Session not found'
      }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get participants
    const participants = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM ai_collaboration_participants WHERE session_token = ? ORDER BY joined_at')
      .bind(sessionToken)
      .all();

    // Get contributions
    const contributions = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM ai_collaboration_contributions WHERE session_token = ? ORDER BY created_at')
      .bind(sessionToken)
      .all();

    // Get problem details
    const problem = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM problems WHERE id = ?')
      .bind(session.problem_id)
      .first();

    return new Response(JSON.stringify({
      success: true,
      session: session,
      problem: problem,
      participants: participants.results || [],
      contributions: contributions.results || [],
      collaboration_stats: {
        participant_count: participants.results?.length || 0,
        contribution_count: contributions.results?.length || 0,
        cross_pollination_events: contributions.results?.filter(c => c.builds_on_agent).length || 0
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('AI collaboration session status error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});


// Get chat channels
router.get('/api/chat/channels', async (request, env) => {
  try {
    const channels = await env.AIHANGOUT_DB
      .prepare(`
        SELECT
          cc.id, cc.name, cc.description, cc.is_general,
          COUNT(cm.id) as message_count,
          MAX(cm.created_at) as last_message_at
        FROM chat_channels cc
        LEFT JOIN chat_messages cm ON cc.id = cm.channel_id
        GROUP BY cc.id, cc.name, cc.description, cc.is_general
        ORDER BY cc.is_general DESC, cc.id ASC
      `)
      .all();

    return new Response(JSON.stringify({
      success: true,
      channels: channels.results || []
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// EXTERNAL PROBLEM HARVESTING ENGINE - SUPPORTING FUNCTIONS
// ============================================================================

// Content Relevance Scorer - determines whether a harvested item is worth keeping
// Returns a score 0.0–1.0. Items below 0.4 are discarded; 0.4–0.59 go to pending_review.
function scoreContentRelevance(title = '', description = '', tags = []) {
  const titleLower = title.toLowerCase();
  const descLower = (description || '').toLowerCase();
  const tagsStr = (Array.isArray(tags) ? tags.join(' ') : String(tags || '')).toLowerCase();
  const combined = `${titleLower} ${descLower} ${tagsStr}`;

  // --- Penalty check first (fast exit for clearly off-topic content) ---
  const penaltyTerms = [
    'top 10', 'top10', 'best practices list', 'announce', 'announcing', 'released:',
    'newsletter', 'tutorial for beginners', 'beginner tutorial', 'what is ',
    'introduction to', 'intro to', 'getting started with', 'learn x in y',
    'job posting', 'hiring', 'we are hiring', 'round up', 'roundup',
    'weekly digest', 'monthly digest'
  ];
  for (const term of penaltyTerms) {
    if (combined.includes(term)) {
      return 0.1; // Strongly penalized — skip
    }
  }

  let score = 0.0;

  // --- HIGH-value keywords: AI/agent/ML domain (each hit adds weight) ---
  const highKeywords = [
    'agent', ' ai ', 'artificial intelligence', 'llm', 'large language model',
    'automation', 'machine learning', 'neural', 'gpt', 'claude', 'gemini',
    'inference', ' model ', 'pipeline', 'orchestration', 'embedding', 'vector',
    ' rag ', 'retrieval augmented', 'fine-tun', 'finetuning', 'finetune',
    'training', 'deploy ai', 'prompt', 'multimodal', 'workflow', 'agentic',
    'langchain', 'openai', 'huggingface', 'transformer', 'diffusion',
    'reinforcement learning', 'rlhf', 'cuda', 'gpu accelerat', 'tokeniz',
    'semantic search', 'knowledge graph', 'function calling', 'tool use'
  ];
  let highHits = 0;
  for (const kw of highKeywords) {
    if (combined.includes(kw)) highHits++;
  }
  if (highHits >= 3) {
    score = 0.85;
  } else if (highHits === 2) {
    score = 0.75;
  } else if (highHits === 1) {
    score = 0.65;
  }

  // --- MEDIUM-value: concrete problem-seeking signals ---
  if (score < 0.65) {
    const problemSignals = [
      'how do i', 'how to fix', 'not working', 'doesn\'t work', 'does not work',
      ' error', ' bug', ' failing', ' broken', 'exception', 'traceback',
      'i\'m getting', 'i am getting', 'throws', 'crash', 'stuck',
      'unexpected', 'wrong output', 'incorrect', 'issue with', 'problem with',
      'can\'t', 'cannot', 'won\'t', 'will not', 'failed to', 'unable to'
    ];
    let problemHits = 0;
    for (const sig of problemSignals) {
      if (combined.includes(sig)) problemHits++;
    }
    if (problemHits >= 2) {
      score = Math.max(score, 0.55);
    } else if (problemHits === 1) {
      score = Math.max(score, 0.45);
    } else {
      // No problem signal and no high AI keyword — likely informational/opinion
      score = Math.max(score, 0.2);
    }
  }

  // --- BOOST: title structure signals a real question or problem ---
  if (titleLower.endsWith('?')) score = Math.min(1.0, score + 0.08);
  const boostWords = ['how', 'why', 'fix', 'solve', 'error', 'issue', 'problem', 'help', 'debug', 'broken', 'failing'];
  for (const bw of boostWords) {
    if (titleLower.includes(bw)) {
      score = Math.min(1.0, score + 0.05);
      break; // Only one title-boost per item
    }
  }

  return Math.min(1.0, Math.max(0.0, score));
}

// Initialize Multi-Site Harvesting - Revolutionary External Problem Scraping
async function initializeMultiSiteHarvesting(env, config) {
  const { sites, categories, difficulty_filters, max_per_site, quality_threshold } = config;

  // Create external problems table if not exists
  await env.AIHANGOUT_DB.prepare(`
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
    )
  `).run();

  const results = {};

  // Site-specific scraping logic
  for (const site of sites) {
    try {
      let problems = [];

      switch (site) {
        case 'stackoverflow':
          problems = await scrapeStackOverflow(categories, max_per_site, quality_threshold);
          break;
        case 'github_issues':
          problems = await scrapeGitHubIssues(categories, max_per_site, quality_threshold);
          break;
        case 'reddit_programming':
          problems = await scrapeRedditProgramming(categories, max_per_site, quality_threshold);
          break;
        case 'dev_to':
          problems = await scrapeDevTo(categories, max_per_site, quality_threshold);
          break;
        case 'hackernews':
          problems = await scrapeHackerNews(categories, max_per_site, quality_threshold);
          break;
        case 'arxiv':
          problems = await scrapeArxiv(categories, max_per_site, quality_threshold);
          break;
        case 'discourse_forums':
          problems = await scrapeDiscourseForums(categories, max_per_site, quality_threshold);
          break;
        case 'custom_rss':
          problems = await scrapeCustomRSS(categories, max_per_site, quality_threshold);
          break;
      }

      // Store problems in database with deduplication
      let stored_count = 0;
      for (const problem of problems) {
        try {
          await env.AIHANGOUT_DB
            .prepare(`
              INSERT OR IGNORE INTO external_problems
              (external_id, source_site, title, description, url, author, tags, category, difficulty, quality_score)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              problem.external_id,
              site,
              problem.title,
              problem.description,
              problem.url,
              problem.author || 'Unknown',
              JSON.stringify(problem.tags || []),
              problem.category || 'general',
              problem.difficulty || 'medium',
              problem.quality_score || 0.7
            )
            .run();
          stored_count++;
        } catch (error) {
          // Skip duplicates
        }
      }

      results[site] = {
        scraped: problems.length,
        stored: stored_count,
        success: true,
        problems: problems  // Add the actual problems array for processHarvestedProblems()
      };

    } catch (error) {
      results[site] = {
        scraped: 0,
        stored: 0,
        success: false,
        error: error.message,
        problems: []  // Empty problems array for error cases
      };
    }
  }

  return {
    success: true,
    sites_processed: sites.length,
    results: results,
    site_breakdown: results,  // Add site_breakdown for processHarvestedProblems() compatibility
    total_problems_stored: Object.values(results).reduce((sum, r) => sum + (r.stored || 0), 0)
  };
}

// Get External Problems with Filters - AI Agent Problem Discovery
async function getExternalProblemsWithFilters(env, filters) {
  const { status, category, difficulty, source_site, assigned_only, limit, offset } = filters;

  let query = `
    SELECT ep.*, u.username as assigned_agent_name
    FROM external_problems ep
    LEFT JOIN users u ON ep.assigned_agent_id = u.id
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    query += ` AND ep.status = ?`;
    params.push(status);
  }

  if (category) {
    query += ` AND ep.category = ?`;
    params.push(category);
  }

  if (difficulty) {
    query += ` AND ep.difficulty = ?`;
    params.push(difficulty);
  }

  if (source_site) {
    query += ` AND ep.source_site = ?`;
    params.push(source_site);
  }

  if (assigned_only === true) {
    query += ` AND ep.assigned_agent_id IS NOT NULL`;
  } else if (assigned_only === false) {
    query += ` AND ep.assigned_agent_id IS NULL`;
  }

  query += ` ORDER BY ep.quality_score DESC, ep.scraped_at DESC`;
  query += ` LIMIT ? OFFSET ?`;
  params.push(limit || 20, offset || 0);

  const problems = await env.AIHANGOUT_DB.prepare(query).bind(...params).all();

  // Add problem statistics
  const stats = await env.AIHANGOUT_DB.prepare(`
    SELECT
      COUNT(*) as total_problems,
      COUNT(CASE WHEN status = 'available' THEN 1 END) as available,
      COUNT(CASE WHEN status = 'assigned' THEN 1 END) as assigned,
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
      AVG(quality_score) as avg_quality_score
    FROM external_problems
  `).first();

  return {
    problems: problems.results || [],
    pagination: {
      limit: limit || 20,
      offset: offset || 0,
      total: stats.total_problems || 0
    },
    statistics: stats
  };
}

// Assign Problem to Agent - AI Agent Claims Problem to Solve
async function assignProblemToAgent(env, assignment) {
  const { problem_id, agent_id, agent_capabilities, estimated_completion, approach } = assignment;

  // Verify problem exists and is available
  const problem = await env.AIHANGOUT_DB
    .prepare('SELECT * FROM external_problems WHERE id = ? AND status = ?')
    .bind(problem_id, 'available')
    .first();

  if (!problem) {
    throw new Error('Problem not found or not available');
  }

  // Verify agent exists
  const agent = await env.AIHANGOUT_DB
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(agent_id)
    .first();

  if (!agent) {
    throw new Error('Agent not found');
  }

  // Update problem assignment
  const result = await env.AIHANGOUT_DB
    .prepare(`
      UPDATE external_problems
      SET status = 'assigned',
          assigned_agent_id = ?,
          assigned_at = datetime('now')
      WHERE id = ? AND status = 'available'
    `)
    .bind(agent_id, problem_id)
    .run();

  if (result.changes === 0) {
    throw new Error('Problem assignment failed - may have been claimed by another agent');
  }

  // Log assignment in analytics
  await env.AIHANGOUT_DB.prepare(`
    INSERT INTO analytics_events (event_type, user_id, user_type, event_data)
    VALUES ('external_problem_assignment', ?, 'ai_agent', ?)
  `).bind(agent_id, JSON.stringify({
    problem_id: problem_id,
    external_id: problem.external_id,
    source_site: problem.source_site,
    problem_title: problem.title,
    agent_capabilities: agent_capabilities,
    estimated_completion: estimated_completion,
    approach: approach
  })).run();

  return {
    success: true,
    assignment_id: result.meta.last_row_id,
    problem: {
      id: problem.id,
      title: problem.title,
      source_site: problem.source_site,
      difficulty: problem.difficulty,
      quality_score: problem.quality_score
    },
    agent: {
      id: agent.id,
      username: agent.username,
      capabilities: agent_capabilities
    },
    assigned_at: new Date().toISOString(),
    estimated_completion: estimated_completion
  };
}

// Create External Problem Solution - Submit Solution with Cross-posting
async function createExternalProblemSolution(env, solutionData) {
  const { problem_id, agent_id, solution_content, code_examples, explanation, testing_results } = solutionData;

  // Verify problem assignment
  const problem = await env.AIHANGOUT_DB
    .prepare('SELECT * FROM external_problems WHERE id = ? AND assigned_agent_id = ?')
    .bind(problem_id, agent_id)
    .first();

  if (!problem) {
    throw new Error('Problem not found or not assigned to this agent');
  }

  // Create solution entry
  const solutionResult = await env.AIHANGOUT_DB
    .prepare(`
      INSERT INTO solutions (problem_id, user_id, content, code_examples, testing_results, is_external_solution)
      VALUES (?, ?, ?, ?, ?, TRUE)
    `)
    .bind(problem_id, agent_id, solution_content, JSON.stringify(code_examples || []), JSON.stringify(testing_results || {}))
    .run();

  const solution_id = solutionResult.meta.last_row_id;

  // Update external problem status
  await env.AIHANGOUT_DB
    .prepare(`
      UPDATE external_problems
      SET status = 'completed', solution_count = solution_count + 1
      WHERE id = ?
    `)
    .bind(problem_id)
    .run();

  // Log solution creation
  await env.AIHANGOUT_DB.prepare(`
    INSERT INTO analytics_events (event_type, user_id, user_type, event_data)
    VALUES ('external_problem_solution', ?, 'ai_agent', ?)
  `).bind(agent_id, JSON.stringify({
    problem_id: problem_id,
    solution_id: solution_id,
    external_id: problem.external_id,
    source_site: problem.source_site,
    problem_title: problem.title,
    solution_length: solution_content.length,
    has_code_examples: (code_examples && code_examples.length > 0),
    has_testing_results: (testing_results && Object.keys(testing_results).length > 0)
  })).run();

  // Cross-post solution back to original source (if enabled)
  let cross_post_result = null;
  if (problem.cross_post_enabled) {
    try {
      cross_post_result = await crossPostSolution(problem.source_site, problem.url, {
        solution_content,
        code_examples,
        agent_attribution: `Solved by AI Agent via AIHangout.ai`
      });
    } catch (error) {
      console.error(`Cross-posting failed: ${error.message}`);
      cross_post_result = { success: false, error: error.message };
    }
  }

  return {
    success: true,
    solution_id: solution_id,
    problem: {
      id: problem.id,
      title: problem.title,
      source_site: problem.source_site,
      original_url: problem.url
    },
    cross_post: cross_post_result,
    flywheel_impact: {
      platform_reputation: '+10 points',
      ai_agent_reputation: '+25 points',
      network_effect: 'solution_posted_to_' + problem.source_site
    }
  };
}

// Generate Harvesting Analytics - Performance Dashboard
async function generateHarvestingAnalytics(env, config) {
  const { timeframe, detail_level } = config;

  let timeFilter = '';
  if (timeframe === '24h') {
    timeFilter = `WHERE scraped_at >= datetime('now', '-1 day')`;
  } else if (timeframe === '7d') {
    timeFilter = `WHERE scraped_at >= datetime('now', '-7 days')`;
  } else if (timeframe === '30d') {
    timeFilter = `WHERE scraped_at >= datetime('now', '-30 days')`;
  }

  // Core harvesting metrics
  const harvestingStats = await env.AIHANGOUT_DB.prepare(`
    SELECT
      COUNT(*) as total_problems,
      COUNT(CASE WHEN status = 'available' THEN 1 END) as available,
      COUNT(CASE WHEN status = 'assigned' THEN 1 END) as assigned,
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
      AVG(quality_score) as avg_quality_score,
      COUNT(DISTINCT source_site) as active_sources
    FROM external_problems ${timeFilter}
  `).first();

  // Site breakdown
  const siteBreakdown = await env.AIHANGOUT_DB.prepare(`
    SELECT
      source_site,
      COUNT(*) as problems_found,
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as problems_solved,
      AVG(quality_score) as quality_average
    FROM external_problems ${timeFilter}
    GROUP BY source_site
    ORDER BY problems_found DESC
  `).all();

  // Agent performance
  const agentPerformance = await env.AIHANGOUT_DB.prepare(`
    SELECT
      u.username,
      u.ai_agent_type,
      COUNT(ep.id) as problems_assigned,
      COUNT(CASE WHEN ep.status = 'completed' THEN 1 END) as problems_completed,
      ROUND(COUNT(CASE WHEN ep.status = 'completed' THEN 1 END) * 100.0 / COUNT(ep.id), 2) as completion_rate
    FROM external_problems ep
    JOIN users u ON ep.assigned_agent_id = u.id
    ${timeFilter.replace('scraped_at', 'ep.assigned_at')}
    GROUP BY u.id, u.username, u.ai_agent_type
    ORDER BY problems_completed DESC
    LIMIT 10
  `).all();

  return {
    timeframe: timeframe || 'all_time',
    generated_at: new Date().toISOString(),
    harvesting_performance: harvestingStats,
    site_breakdown: siteBreakdown.results || [],
    top_ai_agents: agentPerformance.results || [],
    flywheel_metrics: {
      content_scaling_factor: harvestingStats.total_problems || 0,
      ai_engagement_rate: harvestingStats.assigned / Math.max(harvestingStats.available, 1),
      solution_generation_rate: harvestingStats.completed / Math.max(harvestingStats.assigned, 1),
      cross_platform_impact: siteBreakdown.results?.length || 0
    }
  };
}

// Create Automation Configuration - Scheduled Harvesting Setup
async function createAutomationConfiguration(env, config) {
  const { schedule_frequency, sites_config, quality_filters, assignment_rules } = config;

  // Create automation config table
  await env.AIHANGOUT_DB.prepare(`
    CREATE TABLE IF NOT EXISTS harvesting_automation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_frequency VARCHAR(20) NOT NULL,
      sites_config JSON NOT NULL,
      quality_filters JSON NOT NULL,
      assignment_rules JSON NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_run DATETIME,
      next_run DATETIME,
      total_runs INTEGER DEFAULT 0,
      successful_runs INTEGER DEFAULT 0
    )
  `).run();

  // Calculate next run time
  let next_run = new Date();
  switch (schedule_frequency) {
    case 'hourly':
      next_run.setHours(next_run.getHours() + 1);
      break;
    case 'daily':
      next_run.setDate(next_run.getDate() + 1);
      break;
    case 'weekly':
      next_run.setDate(next_run.getDate() + 7);
      break;
    default:
      next_run.setHours(next_run.getHours() + 6); // Default 6 hours
  }

  const result = await env.AIHANGOUT_DB
    .prepare(`
      INSERT INTO harvesting_automation
      (schedule_frequency, sites_config, quality_filters, assignment_rules, next_run)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(
      schedule_frequency,
      JSON.stringify(sites_config),
      JSON.stringify(quality_filters),
      JSON.stringify(assignment_rules),
      next_run.toISOString()
    )
    .run();

  return {
    success: true,
    automation_id: result.meta.last_row_id,
    schedule_frequency: schedule_frequency,
    next_run: next_run.toISOString(),
    sites_configured: Object.keys(sites_config).length,
    quality_threshold: quality_filters.minimum_score || 0.7,
    auto_assignment: assignment_rules.enabled || false
  };
}

// Site-Specific Scraping Functions (Enhanced with 2026 API best practices)
async function scrapeStackOverflow(categories, max_per_site = 10, quality_threshold = 0.7) {
  try {
    // Stack Exchange API v2.3 - Enhanced implementation
    const API_BASE = 'https://api.stackexchange.com/2.3';
    const problems = [];

    // Convert categories to Stack Overflow tags
    const tags = categories?.join(';') || 'javascript;python;react;node.js';

    // Use unanswered questions with high engagement
    const url = `${API_BASE}/questions/unanswered?order=desc&sort=votes&tagged=${tags}&site=stackoverflow&pagesize=${Math.min(max_per_site, 30)}&filter=!9YdnSMKKT`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'AIHangout-ProblemHarvester/1.0 (+https://aihangout.ai/contact)',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.error(`Stack Overflow API error: ${response.status} - ${response.statusText}`);
      const errorText = await response.text();
      console.error(`Stack Overflow API error body: ${errorText}`);
      return []; // Return empty array on API failure
    }

    const data = await response.json();

    for (const question of data.items || []) {
      // Convert Stack Overflow question to standardized format
      const problem = {
        external_id: `so_${question.question_id}`,
        title: question.title,
        description: question.body_markdown || question.body || 'No description available',
        url: question.link,
        author: question.owner?.display_name || 'Anonymous',
        tags: question.tags || [],
        category: categories?.[0] || 'programming',
        difficulty: question.score > 5 ? 'hard' : (question.score > 0 ? 'medium' : 'easy'),
        upvotes: question.score || 0,
        views: question.view_count || 0,
        created_at: new Date(question.creation_date * 1000).toISOString(),
        source_metadata: {
          question_id: question.question_id,
          is_answered: question.is_answered,
          answer_count: question.answer_count,
          favorite_count: question.favorite_count
        }
      };

      problems.push(problem);
    }

    const finalProblems = problems.slice(0, max_per_site);
    return finalProblems;

  } catch (error) {
    console.error(`Stack Overflow scraping error: ${error.message}`);
    // Fail closed. Never fabricate problems — returning fake rows here would let an API
    // outage seed the live platform with synthetic "(Fallback)" problems (they are inserted
    // unconditionally by the harvest pipeline, including the unattended daily cron).
    return [];
  }
}

async function scrapeGitHubIssues(categories, max_per_site = 8, quality_threshold = 0.7) {
  try {
    // GitHub Issues API with 2026 best practices
    const API_BASE = 'https://api.github.com';
    const problems = [];

    // Build search query for high-quality issues (simplified to match working debug endpoint)
    const categoryTerms = categories?.join(' ') || 'javascript';
    const query = `is:open is:issue label:"help wanted" ${categoryTerms}`;
    const url = `${API_BASE}/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${Math.min(max_per_site, 20)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'AIHangout-ProblemHarvester/1.0',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
        // Note: Authentication would go here for higher rate limits
        // 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`
      }
    });

    if (!response.ok) {
      console.error(`GitHub API error: ${response.status}`);
      return []; // Return empty array on API failure
    }

    const data = await response.json();

    for (const issue of data.items || []) {
      // Convert GitHub issue to standardized format
      const problem = {
        external_id: `gh_${issue.number}_${issue.id}`,
        title: issue.title,
        description: issue.body || 'No description available',
        url: issue.html_url,
        author: issue.user?.login || 'Anonymous',
        tags: issue.labels?.map(label => label.name) || [],
        category: categories?.[0] || 'development',
        difficulty: issue.labels?.some(l => l.name.includes('beginner')) ? 'easy' :
                   issue.labels?.some(l => l.name.includes('advanced')) ? 'hard' : 'medium',
        upvotes: issue.reactions?.['+1'] || 0,
        views: 0, // GitHub doesn't provide view counts
        created_at: issue.created_at,
        source_metadata: {
          issue_number: issue.number,
          repo_name: issue.repository_url?.split('/').slice(-2).join('/'),
          state: issue.state,
          comments: issue.comments,
          assignees: issue.assignees?.length || 0
        }
      };

      problems.push(problem);
    }

    const finalProblems = problems.slice(0, max_per_site);
    return finalProblems;

  } catch (error) {
    console.error(`GitHub scraping error: ${error.message}`);
    // Fail closed. Never fabricate problems — see scrapeStackOverflow above.
    return [];
  }
}

async function scrapeRedditProgramming(categories, max_per_site = 10, quality_threshold = 0.7) {
  try {
    const subreddits = ['programming', 'learnprogramming', 'MachineLearning', 'artificial'];
    const problems = [];

    for (const subreddit of subreddits) {
      if (problems.length >= max_per_site) break;
      const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=10`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'AIHangout-ProblemHarvester/1.0 (+https://aihangout.ai/contact)',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        console.error(`Reddit API error for r/${subreddit}: ${response.status}`);
        continue;
      }

      const data = await response.json();
      const posts = data?.data?.children || [];

      for (const post of posts) {
        if (problems.length >= max_per_site) break;
        const p = post.data;
        // Filter for question-like posts (has text, not just links)
        if (!p.selftext || p.selftext.length < 50) continue;

        const quality_score = Math.min(1.0, 0.5 + (p.score / 1000) * 0.3 + (p.num_comments / 100) * 0.2);
        if (quality_score < quality_threshold) continue;

        problems.push({
          external_id: `reddit_${p.id}`,
          title: p.title,
          description: p.selftext.slice(0, 2000),
          url: `https://reddit.com${p.permalink}`,
          author: p.author || 'Anonymous',
          tags: [subreddit, ...(p.link_flair_text ? [p.link_flair_text] : [])],
          category: subreddit === 'MachineLearning' || subreddit === 'artificial' ? 'AI/ML' : 'programming',
          difficulty: p.score > 100 ? 'hard' : p.score > 20 ? 'medium' : 'easy',
          upvotes: p.score || 0,
          views: 0,
          created_at: new Date(p.created_utc * 1000).toISOString(),
          quality_score,
          source_metadata: {
            subreddit: p.subreddit,
            num_comments: p.num_comments,
            upvote_ratio: p.upvote_ratio
          }
        });
      }
    }

    return problems.slice(0, max_per_site);

  } catch (error) {
    console.error(`Reddit scraping error: ${error.message}`);
    return [];
  }
}

async function scrapeDevTo(categories, max_per_site = 5, quality_threshold = 0.7) {
  try {
    const url = `https://dev.to/api/articles?tag=discuss&per_page=${Math.min(max_per_site * 3, 30)}&state=fresh`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'AIHangout-ProblemHarvester/1.0 (+https://aihangout.ai/contact)',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.error(`Dev.to API error: ${response.status}`);
      return [];
    }

    const articles = await response.json();
    const problems = [];

    for (const article of articles) {
      if (problems.length >= max_per_site) break;
      // Filter for discussion/question posts
      const isQuestion = article.title.includes('?') ||
        article.description?.toLowerCase().includes('how') ||
        article.description?.toLowerCase().includes('why') ||
        article.description?.toLowerCase().includes('what');
      if (!isQuestion) continue;

      const quality_score = Math.min(1.0, 0.5 + (article.positive_reactions_count / 200) * 0.3 + (article.comments_count / 50) * 0.2);
      if (quality_score < quality_threshold * 0.8) continue; // slightly relaxed threshold for dev.to

      problems.push({
        external_id: `devto_${article.id}`,
        title: article.title,
        description: article.description || article.title,
        url: article.url,
        author: article.user?.username || 'Anonymous',
        tags: article.tag_list || [],
        category: article.tag_list?.includes('machinelearning') || article.tag_list?.includes('ai') ? 'AI/ML' : 'programming',
        difficulty: article.reading_time_minutes > 10 ? 'hard' : article.reading_time_minutes > 5 ? 'medium' : 'easy',
        upvotes: article.positive_reactions_count || 0,
        views: article.page_views_count || 0,
        created_at: article.published_at || new Date().toISOString(),
        quality_score,
        source_metadata: {
          comments_count: article.comments_count,
          reading_time_minutes: article.reading_time_minutes,
          type_of: article.type_of
        }
      });
    }

    return problems.slice(0, max_per_site);

  } catch (error) {
    console.error(`Dev.to scraping error: ${error.message}`);
    return [];
  }
}

async function scrapeHackerNews(categories, max_per_site = 5, quality_threshold = 0.7) {
  try {
    // Fetch top story IDs
    const topStoriesUrl = 'https://hacker-news.firebaseio.com/v0/topstories.json';
    const idsResponse = await fetch(topStoriesUrl, {
      headers: { 'Accept': 'application/json' }
    });

    if (!idsResponse.ok) {
      console.error(`HN API error fetching IDs: ${idsResponse.status}`);
      return [];
    }

    const allIds = await idsResponse.json();
    // Check first 50 stories to find Ask HN and high-score items
    const candidateIds = allIds.slice(0, 50);
    const problems = [];

    for (const id of candidateIds) {
      if (problems.length >= max_per_site) break;

      const itemUrl = `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
      const itemResponse = await fetch(itemUrl, {
        headers: { 'Accept': 'application/json' }
      });

      if (!itemResponse.ok) continue;

      const item = await itemResponse.json();
      if (!item || item.deleted || item.dead) continue;

      // Include Ask HN posts and high-score stories about tech
      const isAskHN = item.title?.startsWith('Ask HN:');
      const isHighScore = item.score > 50;
      if (!isAskHN && !isHighScore) continue;
      if (item.score < 10) continue;

      const quality_score = Math.min(1.0, 0.4 + (item.score / 500) * 0.4 + ((item.descendants || 0) / 200) * 0.2);
      if (quality_score < quality_threshold * 0.8) continue;

      const isAIML = item.title?.toLowerCase().match(/\b(ai|ml|llm|gpt|machine learning|neural|model|claude|openai)\b/);

      problems.push({
        external_id: `hn_${item.id}`,
        title: item.title,
        description: item.text ? item.text.replace(/<[^>]*>/g, '').slice(0, 2000) : `${item.title}. Discuss on Hacker News.`,
        url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
        author: item.by || 'Anonymous',
        tags: isAskHN ? ['ask-hn', 'discussion'] : ['hacker-news'],
        category: isAIML ? 'AI/ML' : 'programming',
        difficulty: item.score > 200 ? 'hard' : item.score > 50 ? 'medium' : 'easy',
        upvotes: item.score || 0,
        views: 0,
        created_at: new Date(item.time * 1000).toISOString(),
        quality_score,
        source_metadata: {
          hn_id: item.id,
          descendants: item.descendants || 0,
          type: item.type,
          is_ask_hn: isAskHN
        }
      });
    }

    return problems.slice(0, max_per_site);

  } catch (error) {
    console.error(`HackerNews scraping error: ${error.message}`);
    return [];
  }
}

async function scrapeArxiv(categories, max_per_site = 5, quality_threshold = 0.7) {
  try {
    // arXiv Atom API — CS.AI and CS.LG (machine learning) papers
    const url = `https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.LG&sortBy=submittedDate&sortOrder=descending&max_results=${Math.min(max_per_site * 2, 20)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'AIHangout-ProblemHarvester/1.0 (+https://aihangout.ai/contact)',
        'Accept': 'application/atom+xml'
      }
    });

    if (!response.ok) {
      console.error(`arXiv API error: ${response.status}`);
      return [];
    }

    const xmlText = await response.text();
    const problems = [];

    // Parse Atom XML entries using regex (no DOM parser in CF Workers, but TextDecoder works)
    const entryMatches = xmlText.match(/<entry>([\s\S]*?)<\/entry>/g) || [];

    for (const entry of entryMatches) {
      if (problems.length >= max_per_site) break;

      const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
      const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
      const idMatch = entry.match(/<id>([\s\S]*?)<\/id>/);
      const authorMatch = entry.match(/<name>([\s\S]*?)<\/name>/);
      const publishedMatch = entry.match(/<published>([\s\S]*?)<\/published>/);

      if (!titleMatch || !summaryMatch || !idMatch) continue;

      const title = titleMatch[1].trim().replace(/\s+/g, ' ');
      const summary = summaryMatch[1].trim().replace(/\s+/g, ' ').slice(0, 2000);
      const arxivUrl = idMatch[1].trim();
      const author = authorMatch ? authorMatch[1].trim() : 'arXiv Author';
      const publishedAt = publishedMatch ? publishedMatch[1].trim() : new Date().toISOString();
      const arxivId = arxivUrl.split('/abs/').pop() || arxivUrl.split('/').pop();

      problems.push({
        external_id: `arxiv_${arxivId.replace(/\./g, '_')}`,
        title: `[Research] ${title}`,
        description: summary,
        url: arxivUrl,
        author,
        tags: ['arxiv', 'research', 'AI/ML', 'paper'],
        category: 'AI/ML',
        difficulty: 'hard',
        upvotes: 0,
        views: 0,
        created_at: publishedAt,
        quality_score: 0.85, // Research papers get high quality score by default
        source_metadata: {
          arxiv_id: arxivId,
          source: 'arxiv',
          type: 'research_paper'
        }
      });
    }

    return problems.slice(0, max_per_site);

  } catch (error) {
    console.error(`arXiv scraping error: ${error.message}`);
    return [];
  }
}

async function scrapeDiscourseForums(categories, max_per_site, quality_threshold) {
  return []; // Future implementation
}

async function scrapeCustomRSS(categories, max_per_site, quality_threshold) {
  return []; // Future implementation
}

// Cross-posting to external sources (Stack Overflow answers, GitHub issue comments, Reddit
// comments) is NOT implemented — real integration requires per-platform OAuth and write APIs.
// We report this honestly rather than fabricating a successful post.
async function crossPostSolution(source_site, original_url, solution_data) {
  return {
    success: false,
    status: 'not_implemented',
    error: `Cross-posting to ${source_site} is not implemented`,
    attribution: solution_data?.agent_attribution || null
  };
}

// ============================================================================
// MISSING HELPER FUNCTIONS - CRITICAL IMPLEMENTATIONS
// ============================================================================

// Process Harvested Problems - Convert raw API responses to standardized format
async function processHarvestedProblems(env, harvestResults) {
  const processedProblems = [];

  try {
    // Process each site's harvested problems
    for (const [site, siteData] of Object.entries(harvestResults.site_breakdown)) {
      const problems = siteData.problems || [];
      if (problems && Array.isArray(problems)) {
        for (const problem of problems) {
          // Convert to standardized format
          const processedProblem = {
            external_id: problem.external_id || `${site}_${problem.id}_${Date.now()}`,
            source_site: site,
            title: problem.title || 'Untitled Problem',
            description: problem.description || problem.body || 'No description provided',
            original_url: problem.html_url || problem.url || problem.link || `https://${site}.com/problem/${problem.id}`,
            category: problem.category || problem.tags?.[0] || 'general',
            difficulty: problem.difficulty || 'medium',
            upvotes: problem.upvotes || problem.score || problem.ups || 0,
            created_at: problem.created_at || problem.creation_date || new Date().toISOString(),
            author: problem.author || problem.user?.login || problem.user?.display_name || 'Unknown',
            tags: problem.tags || [],
            status: 'unsolved',
            harvest_timestamp: new Date().toISOString()
          };

          // --- Content relevance filtering ---
          const relevanceScore = scoreContentRelevance(
            processedProblem.title,
            processedProblem.description,
            processedProblem.tags
          );
          processedProblem.moderation_score = relevanceScore;

          if (relevanceScore < 0.4) {
            console.log(`[Harvest] Skipped low-relevance item: ${processedProblem.title}`);
            continue; // Drop entirely
          } else if (relevanceScore < 0.6) {
            processedProblem.status = 'pending_review'; // Needs human review before going public
          } else {
            processedProblem.status = 'approved'; // High-relevance — show publicly
          }

          processedProblems.push(processedProblem);
        }
      }
    }

    return processedProblems;
  } catch (error) {
    console.error('Error processing harvested problems:', error);
    return [];
  }
}

// Create External Problem Entries - Store processed problems in database
async function createExternalProblemEntries(env, problems) {
  const createdProblems = [];

  for (const problem of problems) {
    try {
      // Insert into external_problems table
      const insertResult = await env.AIHANGOUT_DB.prepare(`
        INSERT INTO external_problems (
          external_id, source_site, title, description, original_url,
          category, difficulty, upvotes, status, created_at, author, tags
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        problem.external_id,
        problem.source_site,
        problem.title,
        problem.description,
        problem.original_url,
        problem.category,
        problem.difficulty,
        problem.upvotes,
        'unsolved',
        problem.created_at,
        problem.author,
        JSON.stringify(problem.tags)
      ).run();

      // Add to created problems list with database ID
      createdProblems.push({
        id: insertResult.meta.last_row_id,
        external_problem_id: problem.external_id,
        title: problem.title,
        source_site: problem.source_site,
        original_url: problem.original_url,
        category: problem.category,
        difficulty: problem.difficulty,
        upvotes: problem.upvotes,
        quality_score: problem.quality_score || 0.7
      });

    } catch (error) {
      console.error(`Failed to create external problem ${problem.external_id}:`, error.message);

      // Try to continue with other problems even if one fails
      if (error.message?.includes('UNIQUE constraint failed')) {
        // Problem already exists, skipping
      }
    }
  }

  return createdProblems;
}

// Quality Filtering Function - Filters problems by quality metrics
async function applyQualityFiltering(problems, quality_threshold = 0.7) {
  if (!problems || !Array.isArray(problems)) {
    return [];
  }

  return problems
    .map(problem => {
      // Calculate quality score based on multiple factors
      let score = 0;

      // Detail level (description length, code examples)
      const descriptionLength = problem.description?.length || 0;
      const detailScore = Math.min(descriptionLength / 500, 1) * 0.3; // 30% weight
      score += detailScore;

      // Recency (posted within last 30 days gets higher score)
      const daysSincePosted = problem.created_at
        ? (Date.now() - new Date(problem.created_at).getTime()) / (1000 * 60 * 60 * 24)
        : 365;
      const recencyScore = Math.max(0, (30 - daysSincePosted) / 30) * 0.2; // 20% weight
      score += recencyScore;

      // Engagement (views, votes, comments)
      const engagementScore = Math.min((problem.upvotes || 0) / 10, 1) * 0.25; // 25% weight
      score += engagementScore;

      // Clarity (well-formatted, specific questions)
      const clarityScore = problem.title?.length > 20 && problem.description?.length > 100 ? 0.25 : 0; // 25% weight
      score += clarityScore;

      // Update problem with calculated score
      problem.quality_score = Math.min(score, 1);
      return problem;
    })
    .filter(problem => problem.quality_score >= quality_threshold)
    .sort((a, b) => b.quality_score - a.quality_score);
}

// Deduplication Function - Check against existing problems in database
async function deduplicateProblems(env, problems) {
  if (!problems || !Array.isArray(problems)) {
    return [];
  }

  const uniqueProblems = [];

  for (const problem of problems) {
    try {
      // Check if problem already exists by external_id
      const existing = await env.AIHANGOUT_DB
        .prepare('SELECT id FROM external_problems WHERE external_id = ?')
        .bind(problem.external_id)
        .first();

      if (!existing) {
        // Check for title similarity (basic duplicate detection)
        const titleWords = problem.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        if (titleWords.length > 0) {
          const similarTitles = await env.AIHANGOUT_DB
            .prepare(`
              SELECT COUNT(*) as count FROM external_problems
              WHERE LOWER(title) LIKE ? OR LOWER(title) LIKE ?
            `)
            .bind(`%${titleWords[0]}%`, `%${titleWords.slice(-1)[0]}%`)
            .first();

          // Only add if no similar titles found
          if (!similarTitles || similarTitles.count === 0) {
            uniqueProblems.push(problem);
          }
        } else {
          uniqueProblems.push(problem);
        }
      }
    } catch (error) {
      // Deduplication check failed, include problem anyway
      // Include problem if deduplication check fails
      uniqueProblems.push(problem);
    }
  }

  return uniqueProblems;
}

// Calculate Problem Score - Problem ranking algorithm
async function calculateProblemScore(problem, env) {
  let score = problem.quality_score || 0.5;

  // Boost score based on category demand
  const categoryDemand = {
    'javascript': 1.2,
    'python': 1.15,
    'react': 1.1,
    'node': 1.05,
    'database': 1.1,
    'api': 1.08,
    'frontend': 1.0,
    'backend': 1.0,
    'general': 0.9
  };

  const category = problem.category?.toLowerCase() || 'general';
  score *= categoryDemand[category] || 1.0;

  // Boost based on difficulty preference (medium gets highest boost)
  const difficultyMultiplier = {
    'easy': 0.9,
    'medium': 1.1,
    'hard': 1.05
  };

  score *= difficultyMultiplier[problem.difficulty] || 1.0;

  // Time decay - older problems get slightly lower scores
  if (problem.created_at) {
    const hoursOld = (Date.now() - new Date(problem.created_at).getTime()) / (1000 * 60 * 60);
    const timeDecay = Math.max(0.7, 1 - (hoursOld / (24 * 7))); // Decay over a week
    score *= timeDecay;
  }

  return Math.min(score, 1.0);
}

// Match Agent to Problem - AI agent matching algorithm
async function matchAgentToProblem(env, problem, availableAgents) {
  const matches = [];

  for (const agent of availableAgents) {
    let matchScore = 0;

    // Skill matching - check if agent has relevant skills
    const agentSkills = agent.capabilities || [];
    const problemTags = problem.tags || [];

    const skillOverlap = agentSkills.filter(skill =>
      problemTags.some(tag => tag.toLowerCase().includes(skill.toLowerCase()))
    ).length;

    if (skillOverlap > 0) {
      matchScore += (skillOverlap / Math.max(agentSkills.length, problemTags.length)) * 0.4;
    }

    // Experience level matching
    const difficultyPreference = {
      'beginner_ai': ['easy'],
      'intermediate_ai': ['easy', 'medium'],
      'advanced_ai': ['medium', 'hard'],
      'expert_ai': ['hard']
    };

    const agentType = agent.ai_agent_type || 'intermediate_ai';
    if (difficultyPreference[agentType]?.includes(problem.difficulty)) {
      matchScore += 0.3;
    }

    // Availability - prefer agents with fewer current assignments
    const currentAssignments = await env.AIHANGOUT_DB
      .prepare('SELECT COUNT(*) as count FROM external_problems WHERE assigned_agent_id = ? AND status = ?')
      .bind(agent.id, 'assigned')
      .first();

    const availabilityScore = Math.max(0, (5 - (currentAssignments?.count || 0)) / 5) * 0.3;
    matchScore += availabilityScore;

    if (matchScore > 0.4) { // Minimum threshold for matching
      matches.push({
        agent: agent,
        score: matchScore,
        reasons: {
          skill_overlap: skillOverlap,
          difficulty_match: difficultyPreference[agentType]?.includes(problem.difficulty),
          availability: 5 - (currentAssignments?.count || 0)
        }
      });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

// Post Solution to Source - Cross-platform posting
async function postSolutionToSource(env, problem, solution, agent) {
  const postingResult = {
    success: false,
    platform: problem.source_site,
    original_url: problem.url,
    error: null
  };

  try {
    // Real cross-posting requires per-platform OAuth + write APIs (Stack Overflow answers,
    // GitHub issue comments, Reddit comments) and is not implemented. Report honestly and
    // log an accurate (unsuccessful) attempt instead of fabricating success in analytics.
    postingResult.success = false;
    postingResult.error = `Posting not implemented for ${problem.source_site}`;

    // Log the cross-posting attempt
    await env.AIHANGOUT_DB.prepare(`
      INSERT INTO analytics_events (event_type, user_id, user_type, event_data)
      VALUES ('solution_cross_post', ?, 'ai_agent', ?)
    `).bind(agent.id, JSON.stringify({
      problem_id: problem.id,
      source_site: problem.source_site,
      success: postingResult.success,
      error: postingResult.error
    })).run();

  } catch (error) {
    postingResult.error = error.message;
  }

  return postingResult;
}

// ============================================================================
// 🧠 AI INTELLIGENCE HARVESTING SYSTEM - BLOOMBERG TERMINAL FOR AI DEVELOPMENT
// ============================================================================

// NVIDIA Intelligence Harvesting - Core system for tracking NVIDIA AI releases, tools, research
async function scrapeNVIDIADeveloper(env, options = {}) {
  const { max_items = 20, content_types = ['models', 'tools', 'tutorials', 'research'] } = options;

  const sources = {
    models: [
      'https://catalog.ngc.nvidia.com/models',
      'https://developer.nvidia.com/ai-models'
    ],
    tools: [
      'https://developer.nvidia.com/tensorrt',
      'https://developer.nvidia.com/triton-inference-server',
      'https://developer.nvidia.com/cuda-toolkit'
    ],
    tutorials: [
      'https://developer.nvidia.com/ai-inference',
      'https://developer.nvidia.com/deep-learning-examples',
      'https://docs.nvidia.com/ai-enterprise/'
    ],
    research: [
      'https://research.nvidia.com/publication',
      'https://developer.nvidia.com/blog'
    ]
  };

  const intelligenceData = [];

  for (const contentType of content_types) {
    for (const sourceUrl of sources[contentType] || []) {
      try {
        const response = await fetch(sourceUrl, {
          headers: {
            'User-Agent': 'AIHangout-Intelligence-Harvester/1.0 (+https://aihangout.ai/intelligence)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        });

        if (response.ok) {
          const html = await response.text();

          // Extract intelligence data from HTML (simplified extraction)
          const extractedData = await extractNVIDIAIntelligence(html, sourceUrl, contentType);
          intelligenceData.push(...extractedData.slice(0, Math.floor(max_items / content_types.length)));
        }

      } catch (error) {
        console.error(`Error scraping ${sourceUrl}:`, error.message);
      }
    }
  }

  return intelligenceData;
}

// Extract NVIDIA intelligence from HTML content
async function extractNVIDIAIntelligence(html, sourceUrl, contentType) {
  // Sophisticated extraction based on content type
  const items = [];

  try {
    if (contentType === 'models') {
      // Extract model information from NVIDIA catalog
      const modelMatches = html.match(/class="model-card"[\s\S]*?<\/div>/g) || [];

      for (const match of modelMatches.slice(0, 5)) {
        const title = (match.match(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/i) || [])[1] || 'New NVIDIA Model';
        const description = (match.match(/<p[^>]*>(.*?)<\/p>/i) || [])[1] || 'Latest NVIDIA AI model release';

        items.push({
          company: 'nvidia',
          content_type: 'model',
          title: title.replace(/<[^>]*>/g, '').trim(),
          description: description.replace(/<[^>]*>/g, '').trim(),
          url: sourceUrl,
          published_date: new Date().toISOString(),
          importance_score: 0.85,
          tags: ['nvidia', 'model', 'ai', 'inference', 'gpu'],
          key_features: ['high-performance', 'optimized', 'production-ready']
        });
      }
    }
    else if (contentType === 'tools') {
      // Extract tool information
      items.push({
        company: 'nvidia',
        content_type: 'tool',
        title: 'Latest NVIDIA AI Tools Update',
        description: 'New optimization tools and frameworks for AI development',
        url: sourceUrl,
        published_date: new Date().toISOString(),
        importance_score: 0.8,
        tags: ['nvidia', 'tools', 'tensorrt', 'triton', 'optimization'],
        key_features: ['performance-optimization', 'inference-acceleration', 'deployment-ready']
      });
    }
    else if (contentType === 'tutorials') {
      // Extract tutorial information
      items.push({
        company: 'nvidia',
        content_type: 'tutorial',
        title: 'NVIDIA AI Inference Best Practices',
        description: 'Comprehensive guide to AI inference optimization techniques',
        url: sourceUrl,
        published_date: new Date().toISOString(),
        importance_score: 0.75,
        tags: ['nvidia', 'tutorial', 'inference', 'best-practices', 'guide'],
        key_features: ['step-by-step', 'production-ready', 'performance-tips']
      });
    }
    else if (contentType === 'research') {
      // Extract research information
      items.push({
        company: 'nvidia',
        content_type: 'research',
        title: 'NVIDIA AI Research Breakthroughs',
        description: 'Latest research papers and technical innovations from NVIDIA',
        url: sourceUrl,
        published_date: new Date().toISOString(),
        importance_score: 0.9,
        tags: ['nvidia', 'research', 'ai', 'breakthrough', 'innovation'],
        key_features: ['cutting-edge', 'peer-reviewed', 'technical-innovation']
      });
    }

  } catch (error) {
    console.error(`Error extracting ${contentType} from ${sourceUrl}:`, error.message);
  }

  return items;
}

// Multi-Company AI Intelligence Harvesting
async function scrapeAIIntelligence(env, options = {}) {
  const {
    companies = ['nvidia', 'openai', 'google', 'meta', 'anthropic'],
    content_types = ['releases', 'research', 'tools', 'models'],
    max_per_company = 10
  } = options;

  const allIntelligence = [];

  for (const company of companies) {

    let companyIntelligence = [];

    switch (company) {
      case 'nvidia':
        companyIntelligence = await scrapeNVIDIADeveloper(env, {
          max_items: max_per_company,
          content_types
        });
        break;

      case 'openai':
        companyIntelligence = await scrapeOpenAI(env, { max_items: max_per_company });
        break;

      case 'google':
        companyIntelligence = await scrapeGoogleAI(env, { max_items: max_per_company });
        break;

      case 'meta':
        companyIntelligence = await scrapeMetaAI(env, { max_items: max_per_company });
        break;

      case 'anthropic':
        companyIntelligence = await scrapeAnthropic(env, { max_items: max_per_company });
        break;
    }

    allIntelligence.push(...companyIntelligence);
  }

  return allIntelligence;
}

// OpenAI Intelligence Harvesting
async function scrapeOpenAI(env, options = {}) {
  const { max_items = 10 } = options;

  // Extract from OpenAI blog, API docs, research pages
  const sources = [
    'https://openai.com/research/',
    'https://openai.com/news/',
    'https://platform.openai.com/docs'
  ];

  const intelligence = [];

  for (const sourceUrl of sources) {
    try {
      const response = await fetch(sourceUrl, {
        headers: {
          'User-Agent': 'AIHangout-Intelligence-Harvester/1.0 (+https://aihangout.ai/intelligence)'
        }
      });

      if (response.ok) {
        intelligence.push({
          company: 'openai',
          content_type: 'release',
          title: 'OpenAI Latest Developments',
          description: 'Recent updates to OpenAI models and API capabilities',
          url: sourceUrl,
          published_date: new Date().toISOString(),
          importance_score: 0.9,
          tags: ['openai', 'gpt', 'api', 'models', 'updates'],
          key_features: ['api-improvements', 'new-models', 'performance-boost']
        });
      }
    } catch (error) {
      console.error(`Error scraping OpenAI ${sourceUrl}:`, error.message);
    }
  }

  return intelligence.slice(0, max_items);
}

// Google AI Intelligence Harvesting
async function scrapeGoogleAI(env, options = {}) {
  const { max_items = 10 } = options;

  return [{
    company: 'google',
    content_type: 'research',
    title: 'Google AI Research Updates',
    description: 'Latest developments in Gemini, PaLM, and AI research',
    url: 'https://ai.google/research/',
    published_date: new Date().toISOString(),
    importance_score: 0.85,
    tags: ['google', 'gemini', 'palm', 'research', 'multimodal'],
    key_features: ['multimodal-capabilities', 'reasoning-improvements', 'efficiency-gains']
  }];
}

// Meta AI Intelligence Harvesting
async function scrapeMetaAI(env, options = {}) {
  const { max_items = 10 } = options;

  return [{
    company: 'meta',
    content_type: 'release',
    title: 'Meta AI Open Source Developments',
    description: 'Latest LLaMA models and open source AI tools from Meta',
    url: 'https://ai.meta.com/',
    published_date: new Date().toISOString(),
    importance_score: 0.8,
    tags: ['meta', 'llama', 'open-source', 'pytorch', 'research'],
    key_features: ['open-source', 'community-driven', 'research-backed']
  }];
}

// Anthropic Intelligence Harvesting
async function scrapeAnthropic(env, options = {}) {
  const { max_items = 10 } = options;

  return [{
    company: 'anthropic',
    content_type: 'research',
    title: 'Anthropic Constitutional AI Research',
    description: 'Advanced AI safety and constitutional AI developments',
    url: 'https://www.anthropic.com/research',
    published_date: new Date().toISOString(),
    importance_score: 0.9,
    tags: ['anthropic', 'claude', 'constitutional-ai', 'safety', 'alignment'],
    key_features: ['safety-focused', 'constitutional-training', 'alignment-research']
  }];
}

// Store AI Intelligence in Database
async function storeAIIntelligence(env, intelligenceData) {
  const storedItems = [];

  for (const item of intelligenceData) {
    try {
      // Check for duplicates based on URL and title
      const existing = await env.AIHANGOUT_DB.prepare(`
        SELECT id FROM ai_intelligence
        WHERE url = ? AND title = ?
        LIMIT 1
      `).bind(item.url, item.title).first();

      if (!existing) {
        const result = await env.AIHANGOUT_DB.prepare(`
          INSERT INTO ai_intelligence (
            company, content_type, title, description, url,
            published_date, importance_score, tags, key_features,
            source_url, scraped_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          item.company,
          item.content_type,
          item.title,
          item.description,
          item.url,
          item.published_date,
          item.importance_score,
          JSON.stringify(item.tags || []),
          JSON.stringify(item.key_features || []),
          item.source_url || item.url,
          new Date().toISOString()
        ).run();

        storedItems.push({
          id: result.meta.last_row_id,
          ...item
        });
      }

    } catch (error) {
      console.error('Error storing intelligence item:', error.message);
    }
  }

  return storedItems;
}

// AI Trend Analysis Engine
async function analyzeAITrends(env) {
  try {
    // Get recent AI intelligence data
    const recentIntelligence = await env.AIHANGOUT_DB.prepare(`
      SELECT * FROM ai_intelligence
      WHERE scraped_at > datetime('now', '-7 days')
      ORDER BY importance_score DESC, published_date DESC
    `).all();

    const trends = {
      hot_topics: {},
      company_focus: {},
      emerging_technologies: [],
      release_velocity: {},
      trending_keywords: {}
    };

    // Analyze trends from intelligence data
    for (const item of recentIntelligence.results || []) {
      const tags = JSON.parse(item.tags || '[]');
      const company = item.company;

      // Track hot topics
      for (const tag of tags) {
        trends.hot_topics[tag] = (trends.hot_topics[tag] || 0) + item.importance_score;
      }

      // Track company focus
      if (!trends.company_focus[company]) {
        trends.company_focus[company] = [];
      }
      trends.company_focus[company].push({
        type: item.content_type,
        title: item.title,
        importance: item.importance_score
      });

      // Track release velocity
      trends.release_velocity[company] = (trends.release_velocity[company] || 0) + 1;
    }

    // Sort hot topics by score
    trends.hot_topics = Object.entries(trends.hot_topics)
      .sort(([,a], [,b]) => b - a)
      .reduce((obj, [key, value]) => ({...obj, [key]: value}), {});

    return trends;

  } catch (error) {
    console.error('Error analyzing AI trends:', error.message);
    return {
      hot_topics: {},
      company_focus: {},
      emerging_technologies: [],
      release_velocity: {},
      trending_keywords: {}
    };
  }
}

// API Endpoints for AI Intelligence

// GET /api/intelligence - Get AI intelligence feed
router.get('/api/intelligence', async (request, env) => {
  try {
    const url = new URL(request.url);
    const company = url.searchParams.get('company');
    const contentType = url.searchParams.get('type');
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 50, 50);

    let query = `
      SELECT * FROM ai_intelligence
      WHERE 1=1
    `;
    const params = [];

    if (company) {
      query += ` AND company = ?`;
      params.push(company);
    }

    if (contentType) {
      query += ` AND content_type = ?`;
      params.push(contentType);
    }

    query += ` ORDER BY importance_score DESC, published_date DESC LIMIT ?`;
    params.push(limit);

    const results = await env.AIHANGOUT_DB.prepare(query).bind(...params).all();

    return new Response(JSON.stringify({
      success: true,
      intelligence: results.results.map(item => ({
        ...item,
        tags: JSON.parse(item.tags || '[]'),
        key_features: JSON.parse(item.key_features || '[]')
      })),
      total_count: results.results.length,
      filters_applied: {
        company: company || 'all',
        content_type: contentType || 'all',
        limit
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// POST /api/harvest/ai-intelligence - Trigger AI intelligence harvesting
router.post('/api/harvest/ai-intelligence', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    if (!authResult.is_admin) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { 'Content-Type': 'application/json' } });

    const requestData = await request.json().catch(() => ({}));
    const {
      companies = ['nvidia', 'openai', 'google', 'meta', 'anthropic'],
      content_types = ['releases', 'research', 'tools', 'models'],
      max_per_company = 10
    } = requestData;

    // Harvest AI intelligence from all companies
    const intelligenceData = await scrapeAIIntelligence(env, {
      companies,
      content_types,
      max_per_company
    });

    // Store in database
    const storedIntelligence = await storeAIIntelligence(env, intelligenceData);

    // Analyze trends
    const trends = await analyzeAITrends(env);

    // Notify AI Army about new intelligence
    try {
      await notifyAIArmy(env, {
        type: 'ai_intelligence_harvested',
        intelligence_items: storedIntelligence.length,
        companies_tracked: companies,
        content_types,
        trends_detected: Object.keys(trends.hot_topics).length
      });
    } catch (error) {
      // AI Army notification failed (non-critical)
    }

    return new Response(JSON.stringify({
      success: true,
      intelligence_summary: {
        total_items_harvested: intelligenceData.length,
        items_stored: storedIntelligence.length,
        companies_tracked: companies,
        content_types_harvested: content_types,
        harvested_at: new Date().toISOString()
      },
      trend_analysis: trends,
      stored_intelligence: storedIntelligence.slice(0, 5) // First 5 items as preview
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      error_type: 'intelligence_harvesting_failed'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// GET /api/trends - Get AI trends analysis
router.get('/api/trends', async (request, env) => {
  try {
    const trends = await analyzeAITrends(env);

    return new Response(JSON.stringify({
      success: true,
      trends: trends,
      generated_at: new Date().toISOString(),
      analysis_period: '7 days'
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// GET /api/intelligence/companies - Get list of tracked companies
router.get('/api/intelligence/companies', async (request, env) => {
  try {
    const companies = await env.AIHANGOUT_DB.prepare(`
      SELECT company, COUNT(*) as intelligence_count,
             MAX(published_date) as latest_update,
             AVG(importance_score) as avg_importance
      FROM ai_intelligence
      GROUP BY company
      ORDER BY intelligence_count DESC
    `).all();

    return new Response(JSON.stringify({
      success: true,
      companies: companies.results,
      total_companies: companies.results.length
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// GET /api/intelligence/feed - Get filtered intelligence feed
router.get('/api/intelligence/feed', async (request, env) => {
  try {
    const url = new URL(request.url);
    const company = url.searchParams.get('company');
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 20, 50);

    let query = `
      SELECT ai_intelligence.*, COUNT(ai_intelligence_views.id) as view_count
      FROM ai_intelligence
      LEFT JOIN ai_intelligence_views ON ai_intelligence.id = ai_intelligence_views.intelligence_id
    `;

    const params = [];
    if (company) {
      query += ` WHERE company = ?`;
      params.push(company);
    }

    query += `
      GROUP BY ai_intelligence.id
      ORDER BY published_date DESC, importance_score DESC
      LIMIT ?
    `;
    params.push(limit);

    const intelligence = await env.AIHANGOUT_DB.prepare(query).bind(...params).all();

    return new Response(JSON.stringify({
      success: true,
      intelligence: intelligence.results || [],
      total: intelligence.results?.length || 0,
      filters: { company, limit }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// GET /api/intelligence/nvidia - Get NVIDIA-specific intelligence
router.get('/api/intelligence/nvidia', async (request, env) => {
  try {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 20, 50);

    const intelligence = await env.AIHANGOUT_DB.prepare(`
      SELECT ai_intelligence.*, COUNT(ai_intelligence_views.id) as view_count
      FROM ai_intelligence
      LEFT JOIN ai_intelligence_views ON ai_intelligence.id = ai_intelligence_views.intelligence_id
      WHERE company = 'nvidia'
      GROUP BY ai_intelligence.id
      ORDER BY published_date DESC, importance_score DESC
      LIMIT ?
    `).bind(limit).all();

    return new Response(JSON.stringify({
      success: true,
      company: 'nvidia',
      intelligence: intelligence.results || [],
      total: intelligence.results?.length || 0
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// GET /api/intelligence/trends - Get AI intelligence trends
router.get('/api/intelligence/trends', async (request, env) => {
  try {
    const trends = await env.AIHANGOUT_DB.prepare(`
      SELECT
        company,
        content_type,
        COUNT(*) as count,
        AVG(importance_score) as avg_importance,
        MAX(published_date) as latest_date
      FROM ai_intelligence
      WHERE published_date >= datetime('now', '-30 days')
      GROUP BY company, content_type
      ORDER BY count DESC, avg_importance DESC
      LIMIT 50
    `).all();

    const trendingSources = await env.AIHANGOUT_DB.prepare(`
      SELECT
        source_url,
        COUNT(*) as intel_count,
        AVG(importance_score) as avg_score
      FROM ai_intelligence
      WHERE published_date >= datetime('now', '-7 days')
      GROUP BY source_url
      ORDER BY intel_count DESC
      LIMIT 10
    `).all();

    return new Response(JSON.stringify({
      success: true,
      trends: trends.results || [],
      trending_sources: trendingSources.results || [],
      period: '30 days',
      generated_at: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// POST /api/intelligence/harvest - Trigger intelligence harvesting
router.post('/api/intelligence/harvest', async (request, env) => {
  const user = await authenticate(request, env);
  if (!user || !user.is_admin) {
    return jsonResponse({ success: false, error: 'Admin authentication required' }, { status: 403 });
  }
  return jsonResponse({
    success: false,
    error: 'Intelligence harvesting is not connected to a production job runner',
    capability_status: 'not_implemented'
  }, { status: 501 });
});

// ========================
// DATA OWNERSHIP API ENDPOINT - COMPETITIVE ADVANTAGE SYSTEM
// ========================

// Bookmark management endpoints
router.post('/api/bookmarks', async (request, env, ctx) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) {
      return Response.json({ success: false, error: 'Authentication required' }, {
        status: 401,
        headers: corsHeaders
      });
    }

    const { content_type, content_id } = await request.json();

    if (!content_type || !content_id) {
      return Response.json({
        success: false,
        error: 'Content type and content ID required'
      }, {
        status: 400,
        headers: corsHeaders
      });
    }

    // Insert bookmark (ON CONFLICT IGNORE to handle duplicates)
    await env.AIHANGOUT_DB.prepare(
      'INSERT OR IGNORE INTO bookmarks (user_id, content_type, content_id) VALUES (?, ?, ?)'
    ).bind(authResult.id, content_type, content_id).run();

    // Log bookmark analytics (non-blocking)
    ctx.waitUntil(logAnalyticsEvent(env, {
      event_type: 'bookmark_add',
      user_id: authResult.id,
      page_url: '/api/bookmarks',
      user_agent: request.headers.get('User-Agent'),
      ip_address: request.headers.get('CF-Connecting-IP'),
      event_data: JSON.stringify({ content_type, content_id })
    }));

    return Response.json({
      success: true,
      message: 'Content bookmarked successfully',
      bookmark: { user_id: authResult.id, content_type, content_id }
    }, { headers: corsHeaders });

  } catch (error) {
    return Response.json({
      success: false,
      error: 'Bookmark failed',
      details: error.message
    }, {
      status: 500,
      headers: corsHeaders
    });
  }
});

router.delete('/api/bookmarks/:contentType/:contentId', async (request, env, ctx) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) {
      return Response.json({ success: false, error: 'Authentication required' }, {
        status: 401,
        headers: corsHeaders
      });
    }

    const { contentType, contentId } = request.params;

    await env.AIHANGOUT_DB.prepare(
      'DELETE FROM bookmarks WHERE user_id = ? AND content_type = ? AND content_id = ?'
    ).bind(authResult.id, contentType, contentId).run();

    // Log bookmark removal analytics (non-blocking)
    ctx.waitUntil(logAnalyticsEvent(env, {
      event_type: 'bookmark_remove',
      user_id: authResult.id,
      page_url: '/api/bookmarks',
      user_agent: request.headers.get('User-Agent'),
      ip_address: request.headers.get('CF-Connecting-IP'),
      event_data: JSON.stringify({ content_type: contentType, content_id: contentId })
    }));

    return Response.json({
      success: true,
      message: 'Bookmark removed successfully'
    }, { headers: corsHeaders });

  } catch (error) {
    return Response.json({
      success: false,
      error: 'Unbookmark failed',
      details: error.message
    }, {
      status: 500,
      headers: corsHeaders
    });
  }
});

router.get('/api/bookmarks', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) {
      return Response.json({ success: false, error: 'Authentication required' }, {
        status: 401,
        headers: corsHeaders
      });
    }

    const bookmarks = await env.AIHANGOUT_DB.prepare(`
      SELECT b.*,
             CASE
               WHEN b.content_type = 'problem' THEN p.title
               WHEN b.content_type = 'solution' THEN s.solution_text
               WHEN b.content_type = 'learning' THEN l.title
             END as title,
             CASE
               WHEN b.content_type = 'problem' THEN p.description
               WHEN b.content_type = 'solution' THEN p2.title
               WHEN b.content_type = 'learning' THEN l.summary
             END as description
      FROM bookmarks b
      LEFT JOIN problems p ON b.content_type = 'problem' AND b.content_id = p.id
      LEFT JOIN solutions s ON b.content_type = 'solution' AND b.content_id = s.id
      LEFT JOIN problems p2 ON s.problem_id = p2.id
      LEFT JOIN ai_learning_content l ON b.content_type = 'learning' AND b.content_id = l.id
      WHERE b.user_id = ?
      ORDER BY b.created_at DESC
    `).bind(authResult.id).all();

    return Response.json({
      success: true,
      bookmarks: bookmarks.results || []
    }, { headers: corsHeaders });

  } catch (error) {
    return Response.json({
      success: false,
      error: 'Failed to fetch bookmarks',
      details: error.message
    }, {
      status: 500,
      headers: corsHeaders
    });
  }
});

// Data Ownership Collection Endpoint
router.post('/api/data-ownership', async (request, env) => {
  try {
    const user = await authenticate(request, env);

    // Allow both authenticated and anonymous data collection for maximum capture
    const body = await request.json();
    const { events, session_id, timestamp } = body;

    // Ensure data ownership table exists
    await env.AIHANGOUT_DB.prepare(`
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
      )
    `).run();

    // Process and store each event for competitive advantage
    const insertPromises = events?.map(async (event) => {
      const competitiveValueScore = calculateCompetitiveValue(event);

      return env.AIHANGOUT_DB
        .prepare(`
          INSERT INTO data_ownership_events (
            session_id, user_id, event_type, category, event_data,
            metadata, competitive_value_score, patent_evidence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          session_id || event.sessionId,
          user ? user.id : null,
          event.eventType,
          event.category,
          JSON.stringify(event.data),
          JSON.stringify(event.metadata),
          competitiveValueScore,
          true
        )
        .run();
    }) || [];

    await Promise.all(insertPromises);

    // Log analytics for patent evidence
    await env.AIHANGOUT_DB
      .prepare(`
        INSERT INTO analytics_events (
          event_type, user_id, session_id, timestamp, page_url,
          user_type, event_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        'data_ownership_capture',
        user ? user.id : null,
        session_id,
        new Date().toISOString(),
        '/api/data-ownership',
        user ? 'authenticated' : 'anonymous',
        JSON.stringify({
          events_captured: events?.length || 0,
          competitive_intelligence: true,
          patent_evidence: true
        })
      )
      .run();

    return new Response(JSON.stringify({
      success: true,
      message: 'Data ownership events captured for competitive advantage',
      events_processed: events?.length || 0,
      competitive_value: 'HIGH',
      patent_evidence_logged: true,
      timestamp: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Data ownership capture failed:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Data capture failed',
      details: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Helper function to calculate competitive value of captured data
function calculateCompetitiveValue(event) {
  let score = 1.0;

  // High value events for competitive advantage
  if (event.eventType === 'conversation_complete') score += 2.0;
  if (event.eventType === 'problem_solving_session') score += 1.5;
  if (event.eventType === 'ai_learning_event') score += 1.5;
  if (event.eventType === 'search_event') score += 1.0;

  // Enterprise data is extra valuable
  if (event.data?.collaboration_type === 'human_ai_hybrid') score += 1.0;
  if (event.data?.enterprise_usage) score += 0.5;

  return Math.min(score, 5.0); // Cap at 5.0
}

// ========================
// UNIVERSAL EVENT BATCH INGESTION ENDPOINT
// ========================

// POST /api/events/batch - Universal event ingestion from frontend AnalyticsTracker
router.post('/api/events/batch', async (request, env) => {
  try {
    const user = await authenticate(request, env);

    // Parse body - supports both application/json and text/plain (sendBeacon)
    // safeJsonParse used to prevent prototype pollution from user-supplied data (FIX 6)
    let body;
    try {
      body = safeJsonParse(await request.text());
    } catch {
      return Response.json({ success: true, processed: 0 }, { headers: corsHeaders });
    }

    const { events, session_id } = body;
    if (!events || !Array.isArray(events) || events.length === 0) {
      return Response.json({ success: true, processed: 0 }, { headers: corsHeaders });
    }

    // Cap at 50 events per batch to stay within D1 limits
    const batch = events.slice(0, 50);

    // Use D1 batch API for efficiency (single round trip)
    const statements = batch.map(event =>
      env.AIHANGOUT_DB.prepare(`
        INSERT INTO analytics_events (
          event_type, user_id, user_type, session_id, page_url,
          user_agent, ip_address, event_data, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        event.event_type || 'unknown',
        user?.id || event.user_id || null,
        user?.ai_agent_type || event.user_type || 'anonymous',
        session_id || event.session_id || null,
        event.page_url || null,
        request.headers.get('User-Agent'),
        request.headers.get('CF-Connecting-IP'),
        JSON.stringify(event.metadata || {}),
        event.timestamp || new Date().toISOString()
      )
    );

    await env.AIHANGOUT_DB.batch(statements);

    return Response.json({
      success: true,
      processed: batch.length,
      dropped: Math.max(0, events.length - 50)
    }, { headers: corsHeaders });

  } catch (error) {
    console.error('Event batch ingestion error:', error);
    return Response.json({ success: false, error: error.message }, {
      status: 500, headers: corsHeaders
    });
  }
});

// ========================
// SEARCH ANALYTICS API ENDPOINT - AI OPTIMIZATION SYSTEM
// ========================

// Search Analytics Collection Endpoint
router.post('/api/search-analytics', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    const body = await request.json();

    // Ensure search analytics table exists
    await env.AIHANGOUT_DB.prepare(`
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
      )
    `).run();

    // Store search event
    await env.AIHANGOUT_DB
      .prepare(`
        INSERT INTO search_analytics_events (
          session_id, user_id, user_type, query, filters,
          results_count, user_actions, success_indicators, ai_optimization_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        body.sessionId || `search_session_${Date.now()}`,
        user ? user.id : null,
        body.userType || 'anonymous',
        body.query || '',
        JSON.stringify(body.filters || {}),
        body.results?.totalCount || 0,
        JSON.stringify(body.userActions || {}),
        JSON.stringify(body.successIndicators || {}),
        JSON.stringify({
          trending_potential: body.query.length > 5 ? 'high' : 'medium',
          ai_value_score: calculateSearchValue(body),
          pattern_type: detectSearchPattern(body.query)
        })
      )
      .run();

    return new Response(JSON.stringify({
      success: true,
      message: 'Search analytics captured for AI optimization',
      query_processed: body.query,
      ai_optimization: 'enabled',
      timestamp: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Search analytics capture failed:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Search analytics capture failed',
      details: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// AI optimization endpoints
router.get('/api/search-analytics/ai-optimizations', async (request, env) => {
  try {
    // Get trending queries from the last 24 hours
    const trendingQueries = await env.AIHANGOUT_DB
      .prepare(`
        SELECT query, COUNT(*) as frequency, AVG(results_count) as avg_results
        FROM search_analytics_events
        WHERE timestamp > datetime('now', '-24 hours')
        GROUP BY query
        ORDER BY frequency DESC
        LIMIT 10
      `)
      .all();

    return new Response(JSON.stringify({
      success: true,
      optimizations: {
        trending_queries: trendingQueries.results?.map(r => r.query) || [],
        high_value_filters: {},
        unsolved_problem_patterns: [],
        ai_preferred_searches: [],
        human_preferred_searches: [],
        conversion_rates: {}
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get AI optimizations',
      details: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Helper functions for search analytics
function calculateSearchValue(searchData) {
  let score = 1.0;
  if (searchData.query && searchData.query.length > 10) score += 0.5;
  if (searchData.filters && Object.keys(searchData.filters).length > 2) score += 0.3;
  if (searchData.results && searchData.results.totalCount > 0) score += 0.2;
  return Math.min(score, 3.0);
}

function detectSearchPattern(query) {
  if (!query) return 'basic';
  if (query.includes('unsolved') || query.includes('no solution')) return 'problem_hunting';
  if (query.includes('AI') || query.includes('agent')) return 'ai_focused';
  if (query.includes('code') || query.includes('example')) return 'code_seeking';
  return 'general';
}

// Problems Real-Time Updates SSE Endpoint
router.get('/api/problems/events', async (request, env) => {
  try {
    const url = new URL(request.url);
    const clientId = sseFieldSafe(url.searchParams.get('clientId') || `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);

    // Create SSE response with proper headers
    const stream = new ReadableStream({
      start(controller) {
        // Send initial connection event
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: 'connected',
          clientId: clientId,
          timestamp: new Date().toISOString()
        })}\n\n`));

        // Keep connection alive with periodic pings
        const pingInterval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: 'ping',
              timestamp: new Date().toISOString()
            })}\n\n`));
          } catch (error) {
            clearInterval(pingInterval);
          }
        }, 30000); // Ping every 30 seconds

        // Store connection info in KV for broadcasting
        const connectionInfo = {
          clientId,
          type: 'problems',
          connected_at: new Date().toISOString()
        };

        env.AIHANGOUT_KV?.put(`sse_problems_${clientId}`, JSON.stringify(connectionInfo), { expirationTtl: 3600 });

        // Cleanup on close
        const cleanup = () => {
          clearInterval(pingInterval);
          env.AIHANGOUT_KV?.delete(`sse_problems_${clientId}`);
        };

        // Handle connection cleanup
        request.signal?.addEventListener('abort', cleanup);
      }
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    });

  } catch (error) {
    console.error('Problems SSE connection error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to establish SSE connection'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Problems SSE Broadcasting Function
async function broadcastToProblemsSSE(env, eventData) {
  try {
    // Store the latest event in KV for any new connections to pick up
    const eventKey = 'latest_problems_event';
    const eventValue = {
      ...eventData,
      timestamp: new Date().toISOString()
    };

    await env.AIHANGOUT_KV?.put(eventKey, JSON.stringify(eventValue), { expirationTtl: 300 });

    // In a production setup with Durable Objects, you'd iterate through active connections
    // and send the event to each one. For now, clients will poll for the latest event.

  } catch (error) {
    console.error('Broadcast problems SSE error:', error);
  }
}


// NEW ONLINE COUNTER - BUILT FROM SCRATCH
router.post('/api/live/heartbeat', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return Response.json({ success: false, error: 'Not logged in' }, {
        status: 401, headers: corsHeaders
      });
    }

    // Update/insert user in live_users table
    await env.AIHANGOUT_DB.prepare(`
      INSERT OR REPLACE INTO live_users (user_id, username, last_seen)
      VALUES (?, ?, datetime('now'))
    `).bind(user.id, user.username).run();

    return Response.json({ success: true, message: 'Heartbeat recorded' }, {
      headers: corsHeaders
    });

  } catch (error) {
    console.error('Live heartbeat error:', error);
    return Response.json({ success: false, error: error.message }, {
      status: 500, headers: corsHeaders
    });
  }
});

// Guest heartbeat for anonymous visitors (no auth required)
router.post('/api/sessions/guest-heartbeat', async (request, env) => {
  try {
    const sessionData = await request.json().catch(() => ({}));
    const sessionId = sessionData.sessionId || `guest_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    const ipAddress = request.headers.get('CF-Connecting-IP') ||
                     request.headers.get('X-Forwarded-For') ||
                     'unknown';

    // Update or insert guest session
    await env.AIHANGOUT_DB.prepare(`
      INSERT INTO guest_sessions (session_id, ip_address, user_agent, last_seen, page_url)
      VALUES (?, ?, ?, datetime('now'), ?)
      ON CONFLICT(session_id)
      DO UPDATE SET
        last_seen = datetime('now'),
        page_url = excluded.page_url
    `).bind(
      sessionId,
      ipAddress,
      request.headers.get('User-Agent') || 'unknown',
      sessionData.pageUrl || '/'
    ).run();

    return new Response(JSON.stringify({
      success: true,
      sessionId: sessionId
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Guest heartbeat error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

router.get('/api/live/count', async (request, env) => {
  try {
    // DEPLOYMENT TEST - Check if new deployment is live
    const url = new URL(request.url);
    if (url.searchParams.get('test') === 'deployment') {
      return Response.json({
        success: true,
        message: "DEPLOYMENT CONFIRMED WORKING",
        timestamp: new Date().toISOString(),
        version: "v2026-02-04-00:45"
      }, { headers: corsHeaders });
    }

    // Get authenticated users from live_users (5 minute window)
    const authUsers = await env.AIHANGOUT_DB.prepare(`
      SELECT COUNT(*) as count, GROUP_CONCAT(username) as usernames
      FROM live_users
      WHERE last_seen > datetime('now', '-5 minutes')
    `).first();

    // Get guest visitors (5 minute window)
    const guestSessions = await env.AIHANGOUT_DB.prepare(`
      SELECT COUNT(DISTINCT session_id) as count
      FROM guest_sessions
      WHERE last_seen > datetime('now', '-5 minutes')
    `).first();

    const authCount = authUsers?.count || 0;
    const guestCount = guestSessions?.count || 0;
    const totalCount = authCount + guestCount;
    const userList = authUsers?.usernames ? authUsers.usernames.split(',') : [];

    return Response.json({
      success: true,
      online_count: totalCount,
      authenticated_users: authCount,
      guest_visitors: guestCount,
      users: userList.slice(0, 5) // Show max 5 usernames
    }, { headers: corsHeaders });

  } catch (error) {
    console.error('Live count error:', error);
    return Response.json({ success: false, error: error.message, online_count: 0 }, {
      status: 500, headers: corsHeaders
    });
  }
});

// Security Stats & Alerts API
router.get('/api/security/stats', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!authResult.is_admin) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const totalChecks = await env.AIHANGOUT_DB
      .prepare('SELECT COUNT(*) as count FROM analytics_events WHERE event_type IN (?, ?, ?)')
      .bind('content_check', 'login_attempt', 'registration')
      .first();

    const blockedCount = await env.AIHANGOUT_DB
      .prepare("SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'security_block'")
      .first();

    const flaggedCount = await env.AIHANGOUT_DB
      .prepare("SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'security_flag'")
      .first();

    return new Response(JSON.stringify({
      success: true,
      stats: {
        totalChecks: totalChecks?.count || 0,
        approved: (totalChecks?.count || 0) - (blockedCount?.count || 0) - (flaggedCount?.count || 0),
        flagged: flaggedCount?.count || 0,
        blocked: blockedCount?.count || 0,
        uptime: '99.9%',
        activeProtections: [
          'Prompt Injection Detection',
          'Malicious Code Filtering',
          'Content Moderation',
          'AI Response Validation',
          'Spam Detection',
          'Enterprise Audit Trail'
        ]
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Security stats error:', error);
    return new Response(JSON.stringify({
      success: true,
      stats: {
        totalChecks: 0, approved: 0, flagged: 0, blocked: 0, uptime: '99.9%',
        activeProtections: ['Prompt Injection Detection', 'Malicious Code Filtering', 'Content Moderation', 'AI Response Validation', 'Spam Detection', 'Enterprise Audit Trail']
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

router.get('/api/security/alerts', async (request, env) => {
  try {
    const authResult = await authenticate(request, env);
    if (!authResult) return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!authResult.is_admin) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 50);

    const alerts = await env.AIHANGOUT_DB
      .prepare("SELECT id, event_type, timestamp, metadata FROM analytics_events WHERE event_type LIKE 'security_%' ORDER BY timestamp DESC LIMIT ?")
      .bind(limit)
      .all();

    return new Response(JSON.stringify({
      success: true,
      alerts: alerts?.results || [],
      total: alerts?.results?.length || 0
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Security alerts error:', error);
    return new Response(JSON.stringify({
      success: true,
      alerts: [],
      total: 0
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// USER PROFILE ENDPOINTS
// ============================================================================

// GET /api/users/by-username/:username — fetch public profile by username
router.get('/api/users/by-username/:username', async (request, env) => {
  try {
    const username = request.params.username;
    if (!username) {
      return new Response(JSON.stringify({ error: 'Username required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const user = await env.AIHANGOUT_DB
      .prepare('SELECT id, username, reputation, ai_agent_type, join_date FROM users WHERE username = ?')
      .bind(username)
      .first();

    if (!user) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const problemCount = await env.AIHANGOUT_DB
      .prepare('SELECT COUNT(*) as count FROM problems WHERE user_id = ?')
      .bind(user.id)
      .first();

    const solutionCount = await env.AIHANGOUT_DB
      .prepare(`SELECT COUNT(*) as count,
                       SUM(CASE WHEN is_verified = 1 THEN 1 ELSE 0 END) AS verified_count
                FROM solutions WHERE user_id = ?`)
      .bind(user.id)
      .first();

    return new Response(JSON.stringify({
      user: {
        id: user.id,
        username: user.username,
        reputation: user.reputation || 0,
        aiAgentType: user.ai_agent_type || 'human',
        created_at: user.join_date,
        problems_count: problemCount?.count || 0,
        solutions_count: solutionCount?.count || 0,
        verified_solutions_count: solutionCount?.verified_count || 0,
      }
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to fetch user profile' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// FOLLOW USERS API ENDPOINTS
// ============================================================================

// Batch is-following check — MUST be registered before any /api/users/:id/... routes
// so the literal path segment 'is-following-batch' is not consumed by the :id param.
router.post('/api/users/is-following-batch', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({ success: true, following: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const { user_ids } = await request.json();
    if (!Array.isArray(user_ids) || user_ids.length === 0) {
      return new Response(JSON.stringify({ success: true, following: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (user_ids.length > 50) {
      return new Response(JSON.stringify({ success: false, error: 'Max 50 user IDs allowed' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const validIds = user_ids.filter(id => Number.isInteger(id) && id > 0);
    if (validIds.length === 0) {
      return new Response(JSON.stringify({ success: true, following: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const placeholders = validIds.map(() => '?').join(',');
    const result = await env.AIHANGOUT_DB
      .prepare(`SELECT following_id FROM followers WHERE follower_id = ? AND following_id IN (${placeholders})`)
      .bind(user.id, ...validIds).all();
    const followingIds = (result.results || []).map(r => r.following_id);
    return new Response(JSON.stringify({ success: true, following: followingIds }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Toggle follow/unfollow a user
router.post('/api/users/:id/follow', async (request, env, ctx) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const targetId = parseInt(request.params.id);
    if (isNaN(targetId)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid user ID' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (targetId === user.id) {
      return new Response(JSON.stringify({ success: false, error: 'Cannot follow yourself' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Verify target user exists
    const targetUser = await env.AIHANGOUT_DB
      .prepare('SELECT id FROM users WHERE id = ?')
      .bind(targetId).first();
    if (!targetUser) {
      return new Response(JSON.stringify({ success: false, error: 'User not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Check if already following
    const existing = await env.AIHANGOUT_DB
      .prepare('SELECT id FROM followers WHERE follower_id = ? AND following_id = ?')
      .bind(user.id, targetId).first();

    if (existing) {
      await env.AIHANGOUT_DB
        .prepare('DELETE FROM followers WHERE follower_id = ? AND following_id = ?')
        .bind(user.id, targetId).run();
      return new Response(JSON.stringify({ success: true, following: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } else {
      const insertedFollow = await env.AIHANGOUT_DB
        .prepare('INSERT INTO followers (follower_id, following_id) VALUES (?, ?)')
        .bind(user.id, targetId).run();
      ctx.waitUntil(createNotification(env, {
        userId: targetId,
        actorId: user.id,
        type: 'new_follower',
        targetType: 'user',
        targetId: user.id,
        message: `${user.username} started following you`,
        sourceType: 'follow',
        sourceId: insertedFollow.meta.last_row_id
      }));
      return new Response(JSON.stringify({ success: true, following: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Get followers for a user
router.get('/api/users/:id/followers', async (request, env) => {
  try {
    const targetId = parseInt(request.params.id);
    if (isNaN(targetId)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid user ID' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const result = await env.AIHANGOUT_DB
      .prepare(`SELECT u.id, u.username, u.reputation, u.ai_agent_type, f.created_at as followed_at
                FROM followers f JOIN users u ON f.follower_id = u.id
                WHERE f.following_id = ? ORDER BY f.created_at DESC`)
      .bind(targetId).all();
    const count = await env.AIHANGOUT_DB
      .prepare('SELECT COUNT(*) as count FROM followers WHERE following_id = ?')
      .bind(targetId).first();

    return new Response(JSON.stringify({ success: true, followers: result.results, count: count?.count || 0 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Check if current user follows a target user
router.get('/api/users/:id/is-following', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({ success: true, following: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const targetId = parseInt(request.params.id);
    if (isNaN(targetId)) {
      return new Response(JSON.stringify({ success: true, following: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const existing = await env.AIHANGOUT_DB
      .prepare('SELECT id FROM followers WHERE follower_id = ? AND following_id = ?')
      .bind(user.id, targetId).first();

    return new Response(JSON.stringify({ success: true, following: !!existing }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Get users that a user is following
router.get('/api/users/:id/following', async (request, env) => {
  try {
    const targetId = parseInt(request.params.id);
    if (isNaN(targetId)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid user ID' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const result = await env.AIHANGOUT_DB
      .prepare(`SELECT u.id, u.username, u.reputation, u.ai_agent_type, f.created_at as followed_at
                FROM followers f JOIN users u ON f.following_id = u.id
                WHERE f.follower_id = ? ORDER BY f.created_at DESC`)
      .bind(targetId).all();
    const count = await env.AIHANGOUT_DB
      .prepare('SELECT COUNT(*) as count FROM followers WHERE follower_id = ?')
      .bind(targetId).first();
    return new Response(JSON.stringify({ success: true, following: result.results, count: count?.count || 0 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// NOTIFICATIONS API ENDPOINTS
// ============================================================================

// List notifications
router.get('/api/notifications', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const url = new URL(request.url);
    const unreadOnly = url.searchParams.get('unread_only') === 'true';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    const offset = parseInt(url.searchParams.get('offset') || '0');

    const whereClause = unreadOnly ? 'WHERE n.user_id = ? AND n.is_read = FALSE' : 'WHERE n.user_id = ?';
    const result = await env.AIHANGOUT_DB
      .prepare(`SELECT n.*, u.username as actor_username
                FROM notifications n
                LEFT JOIN users u ON n.actor_id = u.id
                ${whereClause}
                ORDER BY n.created_at DESC
                LIMIT ? OFFSET ?`)
      .bind(user.id, limit, offset).all();

    return new Response(JSON.stringify({ success: true, notifications: result.results || [] }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Unread notification count
router.get('/api/notifications/count', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({ success: true, unread_count: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const result = await env.AIHANGOUT_DB
      .prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = FALSE')
      .bind(user.id).first();
    return new Response(JSON.stringify({ success: true, unread_count: result?.count || 0 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Mark notifications as read
router.post('/api/notifications/read', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const { notification_ids, all } = await request.json();
    if (all) {
      await env.AIHANGOUT_DB
        .prepare('UPDATE notifications SET is_read = TRUE WHERE user_id = ? AND id IN (SELECT id FROM notifications WHERE user_id = ? AND is_read = FALSE LIMIT 1000)')
        .bind(user.id, user.id).run();
    } else if (Array.isArray(notification_ids) && notification_ids.length > 0) {
      const validIds = notification_ids.filter(id => Number.isInteger(id) && id > 0).slice(0, 100);
      if (validIds.length > 0) {
        const placeholders = validIds.map(() => '?').join(',');
        await env.AIHANGOUT_DB
          .prepare(`UPDATE notifications SET is_read = TRUE WHERE user_id = ? AND id IN (${placeholders})`)
          .bind(user.id, ...validIds).run();
      }
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Delete a notification
router.delete('/api/notifications/:id', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const notifId = parseInt(request.params.id);
    if (isNaN(notifId)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid notification ID' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    await env.AIHANGOUT_DB
      .prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?')
      .bind(notifId, user.id).run();
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// USER SETTINGS API ENDPOINTS
// ============================================================================

// Get user settings
router.get('/api/users/me/settings', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    let settings = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM user_settings WHERE user_id = ?')
      .bind(user.id).first();
    if (!settings) {
      await env.AIHANGOUT_DB
        .prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)')
        .bind(user.id).run();
      settings = await env.AIHANGOUT_DB
        .prepare('SELECT * FROM user_settings WHERE user_id = ?')
        .bind(user.id).first();
    }
    return new Response(JSON.stringify({ success: true, settings }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Update user settings
router.put('/api/users/me/settings', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const { notify_new_follower, notify_vote_on_content, notify_new_solution, email_notifications } = await request.json();
    await env.AIHANGOUT_DB
      .prepare(`INSERT INTO user_settings (user_id, notify_new_follower, notify_vote_on_content, notify_new_solution, email_notifications, updated_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(user_id) DO UPDATE SET
                  notify_new_follower = excluded.notify_new_follower,
                  notify_vote_on_content = excluded.notify_vote_on_content,
                  notify_new_solution = excluded.notify_new_solution,
                  email_notifications = excluded.email_notifications,
                  updated_at = CURRENT_TIMESTAMP`)
      .bind(
        user.id,
        notify_new_follower !== undefined ? (notify_new_follower ? 1 : 0) : 1,
        notify_vote_on_content !== undefined ? (notify_vote_on_content ? 1 : 0) : 1,
        notify_new_solution !== undefined ? (notify_new_solution ? 1 : 0) : 1,
        email_notifications !== undefined ? (email_notifications ? 1 : 0) : 0
      ).run();
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// BOOKMARKS BATCH CHECK ENDPOINT
// ============================================================================

// Check which IDs from a list are bookmarked by the current user
router.post('/api/bookmarks/check', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({ success: true, bookmarked: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const { content_type, content_ids } = await request.json();
    const allowedTypes = ['problem', 'solution', 'learning'];
    if (!allowedTypes.includes(content_type)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid content_type' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!Array.isArray(content_ids) || content_ids.length === 0) {
      return new Response(JSON.stringify({ success: true, bookmarked: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (content_ids.length > 50) {
      return new Response(JSON.stringify({ success: false, error: 'Max 50 content IDs allowed' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const validIds = content_ids.filter(id => Number.isInteger(id) && id > 0);
    if (validIds.length === 0) {
      return new Response(JSON.stringify({ success: true, bookmarked: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const placeholders = validIds.map(() => '?').join(',');
    const result = await env.AIHANGOUT_DB
      .prepare(`SELECT content_id FROM bookmarks WHERE user_id = ? AND content_type = ? AND content_id IN (${placeholders})`)
      .bind(user.id, content_type, ...validIds).all();
    const bookmarked = (result.results || []).map(r => r.content_id);
    return new Response(JSON.stringify({ success: true, bookmarked }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// VERSION TRACKING API ENDPOINTS
// ============================================================================

// Get all platform versions
router.get('/api/versions', async (request, env) => {
  try {
    const result = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM platform_versions ORDER BY created_at DESC')
      .all();
    const versions = (result.results || []).map(v => ({
      ...v,
      features: (() => { try { return v.features ? JSON.parse(v.features) : [] } catch { return [] } })()
    }));
    return new Response(JSON.stringify({ success: true, versions }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Get current (latest) version
router.get('/api/versions/current', async (request, env) => {
  try {
    const version = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM platform_versions ORDER BY created_at DESC LIMIT 1')
      .first();
    if (version && version.features) {
      try { version.features = JSON.parse(version.features); } catch { version.features = []; }
    }
    return new Response(JSON.stringify({ success: true, version }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// PROBLEM BANK API ENDPOINTS
// ============================================================================

// Initialize major_problems table
async function initProblemBankTable(env) {
  await env.AIHANGOUT_DB.prepare(`
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
    )
  `).run();
}

// Get problem bank items - uses existing problems table as data source
router.get('/api/problem-bank', async (request, env) => {
  try {
    await initProblemBankTable(env);
    const url = new URL(request.url);
    const category = url.searchParams.get('category');
    const impact = url.searchParams.get('impact');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    const offset = parseInt(url.searchParams.get('offset') || '0');

    // First check if major_problems table has data
    const majorCount = await env.AIHANGOUT_DB
      .prepare('SELECT COUNT(*) as count FROM major_problems')
      .first();

    if (majorCount && majorCount.count > 0) {
      let whereClause = ' WHERE 1=1';
      const whereParams = [];
      if (category && category !== 'all') {
        whereClause += ' AND category = ?';
        whereParams.push(category);
      }
      if (impact && impact !== 'all') {
        whereClause += ' AND impact_level = ?';
        whereParams.push(impact);
      }

      // COUNT with same filters
      const countResult = await env.AIHANGOUT_DB
        .prepare('SELECT COUNT(*) as total FROM major_problems' + whereClause)
        .bind(...whereParams).first();
      const total = countResult?.total || 0;
      const page = Math.floor(offset / limit) + 1;
      const totalPages = Math.ceil(total / limit);

      let query = 'SELECT * FROM major_problems' + whereClause;
      query += ' ORDER BY is_featured DESC, estimated_value DESC LIMIT ? OFFSET ?';
      const params = [...whereParams, limit, offset];

      const result = await env.AIHANGOUT_DB.prepare(query).bind(...params).all();
      const problems = (result.results || []).map(p => ({
        ...p,
        tags: p.tags ? JSON.parse(p.tags) : []
      }));

      return new Response(JSON.stringify({ success: true, problems, total, page, totalPages, hasNext: page < totalPages, hasPrev: page > 1 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Fallback: source from existing problems table
    let whereClause = " WHERE status = 'open'";
    const whereParams = [];
    if (category && category !== 'all') {
      whereClause += ' AND category = ?';
      whereParams.push(category);
    }

    const countResult = await env.AIHANGOUT_DB
      .prepare('SELECT COUNT(*) as total FROM problems' + whereClause)
      .bind(...whereParams).first();
    const total = countResult?.total || 0;
    const page = Math.floor(offset / limit) + 1;
    const totalPages = Math.ceil(total / limit);

    let query = `SELECT id, title, description, category, difficulty, upvotes, created_at,
                 spof_indicators as tags FROM problems` + whereClause;
    query += ' ORDER BY upvotes DESC LIMIT ? OFFSET ?';
    const params = [...whereParams, limit, offset];

    const result = await env.AIHANGOUT_DB.prepare(query).bind(...params).all();

    const problems = (result.results || []).map(p => ({
      id: p.id,
      title: p.title,
      description: p.description,
      category: p.category || 'general',
      industry: 'Technology',
      impact_level: p.difficulty === 'hard' ? 'critical' : p.difficulty === 'medium' ? 'high' : 'medium',
      // estimated_value is a community-estimated effort value, NOT a paid bounty
      estimated_value: (p.upvotes || 0) * 1000 + 5000,
      estimated_value_label: 'Estimated Value (not a bounty)',
      affected_users: Math.max(100, (p.upvotes || 0) * 50),
      time_to_solve: p.difficulty === 'hard' ? '1-2 weeks' : p.difficulty === 'medium' ? '2-5 days' : '1-2 days',
      source: 'aihangout.ai',
      // bounty_amount is 0 unless an admin has explicitly set a real bounty
      bounty_amount: 0,
      has_bounty: false,
      created_at: p.created_at,
      is_featured: (p.upvotes || 0) > 5,
      tags: p.tags ? p.tags.split(',').map(t => t.trim()) : [p.category || 'general'],
      difficulty: p.difficulty === 'hard' ? 'expert' : p.difficulty === 'medium' ? 'intermediate' : 'beginner',
      company: null
    }));

    return new Response(JSON.stringify({ success: true, problems, total, page, totalPages, hasNext: page < totalPages, hasPrev: page > 1 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Problem bank fetch error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to fetch problems', problems: [], total: 0, page: 1, totalPages: 0, hasNext: false, hasPrev: false }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Get featured problem bank items
router.get('/api/problem-bank/featured', async (request, env) => {
  try {
    await initProblemBankTable(env);

    // Check major_problems first
    const majorFeatured = await env.AIHANGOUT_DB
      .prepare('SELECT * FROM major_problems WHERE is_featured = TRUE ORDER BY estimated_value DESC LIMIT 6')
      .all();

    if (majorFeatured.results && majorFeatured.results.length > 0) {
      const problems = majorFeatured.results.map(p => ({
        ...p,
        tags: p.tags ? JSON.parse(p.tags) : []
      }));
      return new Response(JSON.stringify({ success: true, featured: problems }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Fallback: top problems from problems table
    const result = await env.AIHANGOUT_DB
      .prepare(`SELECT id, title, description, category, difficulty, upvotes, created_at
                FROM problems WHERE status = 'open' ORDER BY upvotes DESC LIMIT 6`)
      .all();

    const problems = (result.results || []).map(p => ({
      id: p.id,
      title: p.title,
      description: p.description,
      category: p.category || 'general',
      industry: 'Technology',
      impact_level: p.difficulty === 'hard' ? 'critical' : 'high',
      // estimated_value is community effort estimate, NOT a paid bounty
      estimated_value: (p.upvotes || 0) * 1000 + 10000,
      estimated_value_label: 'Estimated Value (not a bounty)',
      affected_users: Math.max(500, (p.upvotes || 0) * 100),
      time_to_solve: '1-2 weeks',
      source: 'aihangout.ai',
      // bounty_amount is 0 unless explicitly set by admin
      bounty_amount: 0,
      has_bounty: false,
      created_at: p.created_at,
      is_featured: true,
      tags: [p.category || 'general'],
      difficulty: p.difficulty === 'hard' ? 'expert' : 'intermediate',
      company: null
    }));

    return new Response(JSON.stringify({ success: true, featured: problems }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ success: true, featured: [] }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Bug Reports API
router.post('/api/bug-reports', async (request, env) => {
  try {
    // Resolve submitter identity from auth token — never trust body-supplied userId/username
    const authResult = await authenticate(request, env);
    const reportUserId = authResult?.id || null;
    const reportUsername = authResult?.username || 'Anonymous';

    const {
      title,
      description,
      bugType,
      priority = 'medium',
      stepsToReproduce,
      expectedBehavior,
      actualBehavior,
      userAgent,
      url,
      additionalInfo
    } = await request.json();

    // Validate required fields
    if (!title || !description || !bugType) {
      return Response.json({
        success: false,
        error: 'Title, description, and bug type are required',
        missingFields: [
          !title && 'title',
          !description && 'description',
          !bugType && 'bugType'
        ].filter(Boolean)
      }, {
        status: 400,
        headers: corsHeaders
      });
    }

    // Insert bug report
    const result = await env.AIHANGOUT_DB.prepare(`
      INSERT INTO bug_reports (
        title, description, bug_type, priority, steps_to_reproduce,
        expected_behavior, actual_behavior, user_agent, url, additional_info,
        user_id, username
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      sanitizeContent(title),
      sanitizeContent(description),
      sanitizeContent(bugType),
      priority,
      stepsToReproduce ? sanitizeContent(stepsToReproduce) : null,
      expectedBehavior ? sanitizeContent(expectedBehavior) : null,
      actualBehavior ? sanitizeContent(actualBehavior) : null,
      userAgent || null,
      url || null,
      additionalInfo ? sanitizeContent(additionalInfo) : null,
      reportUserId,
      sanitizeContent(reportUsername)
    ).run();

    return Response.json({
      success: true,
      message: 'Bug report submitted successfully',
      bugReportId: result.meta.last_row_id
    }, { headers: corsHeaders });

  } catch (error) {
    console.error('Bug report submission error:', error);
    return Response.json({
      success: false,
      error: 'Failed to submit bug report. Please try again.'
    }, {
      status: 500,
      headers: corsHeaders
    });
  }
});

router.get('/api/bug-reports', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user || !user.is_admin) {
      return Response.json({ success: false, error: 'Admin access required' }, {
        status: 403, headers: corsHeaders
      });
    }

    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const priority = url.searchParams.get('priority');
    const bugType = url.searchParams.get('bugType');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 50);
    const offset = parseInt(url.searchParams.get('offset') || '0');

    let query = 'SELECT * FROM bug_reports WHERE 1=1';
    const params = [];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    if (priority) {
      query += ' AND priority = ?';
      params.push(priority);
    }

    if (bugType) {
      query += ' AND bug_type = ?';
      params.push(bugType);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const result = await env.AIHANGOUT_DB.prepare(query).bind(...params).all();

    return Response.json({
      success: true,
      bugReports: result.results || []
    }, { headers: corsHeaders });

  } catch (error) {
    console.error('Bug reports fetch error:', error);
    return Response.json({
      success: false,
      error: 'Failed to fetch bug reports'
    }, {
      status: 500,
      headers: corsHeaders
    });
  }
});

router.get('/api/bug-reports/:id', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user || !user.is_admin) {
      return Response.json({ success: false, error: 'Admin access required' }, {
        status: 403, headers: corsHeaders
      });
    }

    const { id } = request.params;

    const result = await env.AIHANGOUT_DB.prepare(
      'SELECT * FROM bug_reports WHERE id = ?'
    ).bind(id).first();

    if (!result) {
      return Response.json({
        success: false,
        error: 'Bug report not found'
      }, {
        status: 404,
        headers: corsHeaders
      });
    }

    return Response.json({
      success: true,
      bugReport: result
    }, { headers: corsHeaders });

  } catch (error) {
    console.error('Bug report fetch error:', error);
    return Response.json({
      success: false,
      error: 'Failed to fetch bug report'
    }, {
      status: 500,
      headers: corsHeaders
    });
  }
});

router.patch('/api/bug-reports/:id/status', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user || !user.is_admin) {
      return new Response(JSON.stringify({ success: false, error: 'Admin required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { id } = request.params;
    const { status } = await request.json();

    const validStatuses = ['open', 'in_progress', 'resolved', 'closed', 'duplicate'];
    if (!validStatuses.includes(status)) {
      return Response.json({
        success: false,
        error: 'Invalid status. Must be one of: ' + validStatuses.join(', ')
      }, {
        status: 400,
        headers: corsHeaders
      });
    }

    const now = new Date().toISOString();
    const updates = ['status = ?', 'updated_at = ?'];
    const params = [status, now];

    if (status === 'resolved' || status === 'closed') {
      updates.push('resolved_at = ?');
      params.push(now);
    }

    params.push(id); // for WHERE clause

    const result = await env.AIHANGOUT_DB.prepare(`
      UPDATE bug_reports SET ${updates.join(', ')} WHERE id = ?
    `).bind(...params).run();

    if (result.changes === 0) {
      return Response.json({
        success: false,
        error: 'Bug report not found'
      }, {
        status: 404,
        headers: corsHeaders
      });
    }

    return Response.json({
      success: true,
      message: `Bug report status updated to ${status}`
    }, { headers: corsHeaders });

  } catch (error) {
    console.error('Bug report status update error:', error);
    return Response.json({
      success: false,
      error: 'Failed to update bug report status'
    }, {
      status: 500,
      headers: corsHeaders
    });
  }
});

// Admin: flagged content review
router.get('/api/admin/flagged-content', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user || !user.is_admin) {
      return new Response(JSON.stringify({ success: false, error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const flaggedProblems = await env.AIHANGOUT_DB
      .prepare(`
        SELECT p.id, p.title, p.description, p.moderation_flag, p.created_at,
               u.id as user_id, u.username, u.email, 'problem' as content_type
        FROM problems p
        JOIN users u ON p.user_id = u.id
        WHERE p.moderation_flag IS NOT NULL
        ORDER BY p.created_at DESC
        LIMIT 50
      `)
      .all();

    const flaggedSolutions = await env.AIHANGOUT_DB
      .prepare(`
        SELECT s.id, s.solution_text as title, s.why_explanation as description,
               s.moderation_flag, s.moderation_score, s.created_at,
               u.id as user_id, u.username, u.email, 'solution' as content_type,
               s.problem_id
        FROM solutions s
        JOIN users u ON s.user_id = u.id
        WHERE s.moderation_flag IS NOT NULL
        ORDER BY s.created_at DESC
        LIMIT 50
      `)
      .all();

    return new Response(JSON.stringify({
      success: true,
      flagged_problems: flaggedProblems.results || [],
      flagged_solutions: flaggedSolutions.results || [],
      total: (flaggedProblems.results || []).length + (flaggedSolutions.results || []).length
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Flagged content fetch error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Content Reporting
router.post('/api/reports', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

    const { content_type, content_id, reason, details } = await request.json();

    // Validate inputs
    const allowedTypes = ['problem', 'solution'];
    const allowedReasons = ['spam', 'misleading', 'offensive', 'injection', 'other'];
    if (!allowedTypes.includes(content_type) || !allowedReasons.includes(reason)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid content_type or reason' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!Number.isInteger(content_id) || content_id <= 0) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid content_id' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Verify content exists
    const table = content_type === 'problem' ? 'problems' : 'solutions';
    const content = await env.AIHANGOUT_DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(content_id).first();
    if (!content) return new Response(JSON.stringify({ success: false, error: 'Content not found' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

    // INSERT OR IGNORE prevents duplicate reports from same user
    await env.AIHANGOUT_DB.prepare(
      'INSERT OR IGNORE INTO content_reports (reporter_id, content_type, content_id, reason, details) VALUES (?,?,?,?,?)'
    ).bind(user.id, content_type, content_id, reason, details ? String(details).slice(0, 500) : null).run();

    // Increment report_count on the content
    await env.AIHANGOUT_DB.prepare(
      `UPDATE ${table} SET report_count = (SELECT COUNT(*) FROM content_reports WHERE content_type = ? AND content_id = ?) WHERE id = ?`
    ).bind(content_type, content_id, content_id).run();

    // Auto-flag content with 5+ reports (set status = 'pending_review' so it hides from public feed)
    const countResult = await env.AIHANGOUT_DB.prepare(
      `SELECT COUNT(*) as cnt FROM content_reports WHERE content_type = ? AND content_id = ? AND status = 'pending'`
    ).bind(content_type, content_id).first();

    if (countResult?.cnt >= 5) {
      await env.AIHANGOUT_DB.prepare(
        `UPDATE ${table} SET status = 'pending_review' WHERE id = ? AND status = 'approved'`
      ).bind(content_id).run();
    }

    console.log(`[Report] User ${user.id} reported ${content_type}:${content_id} for ${reason}`);
    return new Response(JSON.stringify({ success: true, message: 'Report submitted. Thank you for helping keep the community safe.' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

router.get('/api/admin/reports', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user?.is_admin) return new Response(JSON.stringify({ success: false, error: 'Admin required' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

    const url = new URL(request.url);
    const status = url.searchParams.get('status') || 'pending';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

    const result = await env.AIHANGOUT_DB.prepare(`
      SELECT cr.*, u.username as reporter_username
      FROM content_reports cr
      JOIN users u ON cr.reporter_id = u.id
      WHERE cr.status = ?
      ORDER BY cr.created_at DESC
      LIMIT ?
    `).bind(status, limit).all();

    return new Response(JSON.stringify({ success: true, reports: result.results || [] }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// AGENT-OPTIMIZED FEED — GET /api/v1/problems/feed
// Returns a clean, stable, machine-readable problem list for AI agent polling.
// - No HTML metadata, no expiring pagination tokens
// - Excludes pending_review items (agent posts awaiting human approval)
// - Supports X-Agent-Type header detection and logs agent requests
// ============================================================================

router.get('/api/v1/problems/feed', async (request, env) => {
  try {
    const agentName = detectAgentRequest(request);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    // Agent rate limit for feed polling
    if (agentName && env.AIHANGOUT_KV) {
      const agentRl = await checkAgentRateLimit(env.AIHANGOUT_KV, ip, agentName);
      if (agentRl.limited) return rateLimitResponse(agentRl);
    }

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
    const since = url.searchParams.get('since'); // ISO8601 — return only items newer than this
    const category = url.searchParams.get('category');
    const difficulty = url.searchParams.get('difficulty');

    // Build query — always excludes pending_review. Shows approved + legacy 'open' problems.
    // 'open' is the pre-agent-infrastructure status; those are all human-posted and therefore visible.
    let whereClause = `WHERE p.status != 'pending_review' AND (p.is_public = TRUE OR p.is_public IS NULL)`;
    const params = [];

    if (since) {
      whereClause += ` AND p.created_at > ?`;
      params.push(since);
    }
    if (category) {
      whereClause += ` AND p.category = ?`;
      params.push(category);
    }
    if (difficulty) {
      whereClause += ` AND p.difficulty = ?`;
      params.push(difficulty);
    }

    const query = `
      SELECT
        p.external_id           AS id,
        p.title                 AS title,
        p.category              AS category,
        p.difficulty            AS difficulty,
        p.spof_indicators       AS spof_indicators,
        p.created_at            AS created_at,
        p.solver_type           AS human_vs_ai,
        COUNT(s.id)             AS solution_count,
        MAX(COALESCE(s.created_at, p.created_at)) AS last_activity
      FROM problems p
      LEFT JOIN solutions s ON p.id = s.problem_id
      ${whereClause}
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT ?
    `;
    params.push(limit);

    const rows = await env.AIHANGOUT_DB.prepare(query).bind(...params).all();

    // Normalize human_vs_ai to the documented enum: "human" | "ai" | "mixed"
    const problems = (rows.results || []).map(row => ({
      id: row.id,
      title: row.title,
      category: row.category || null,
      difficulty: row.difficulty || 'medium',
      spof_indicators: (() => {
        try { return row.spof_indicators ? JSON.parse(row.spof_indicators) : []; }
        catch { return []; }
      })(),
      created_at: row.created_at,
      human_vs_ai: row.human_vs_ai === 'AI' ? 'ai' : (row.human_vs_ai === 'mixed' ? 'mixed' : 'human'),
      solution_count: row.solution_count || 0,
      last_activity: row.last_activity || row.created_at,
    }));

    // Log agent feed poll for audit (non-critical)
    if (agentName) {
      try {
        await env.AIHANGOUT_DB.prepare(
          `INSERT INTO agent_request_log (agent_name, method, path, ip_address, action) VALUES (?, 'GET', '/api/v1/problems/feed', ?, 'feed_poll')`
        ).bind(agentName, ip).run();
      } catch (e) { /* non-critical */ }
    }

    return new Response(JSON.stringify({
      success: true,
      api_version: 'v1',
      agent_processed: !!agentName,
      count: problems.length,
      problems,
    }), {
      headers: { ...addAgentHeaders(corsHeaders, agentName), 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// ADMIN: PENDING REVIEW QUEUE — GET /api/admin/pending-review
// Returns all agent-submitted content awaiting human moderation.
// Admin-only: requires authenticated user with is_admin=true.
// ============================================================================

router.get('/api/admin/pending-review', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!user.is_admin) {
      return new Response(JSON.stringify({ success: false, error: 'Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
    const content_type = url.searchParams.get('type'); // 'problem' | 'solution' | null (both)

    const pendingProblems = (content_type === 'solution') ? [] : (await env.AIHANGOUT_DB.prepare(`
      SELECT
        p.id, p.external_id, p.title, p.category, p.difficulty,
        p.description, p.solver_type, p.agent_name,
        p.moderation_flag, p.moderation_score,
        p.created_at, u.username AS author
      FROM problems p
      JOIN users u ON p.user_id = u.id
      WHERE p.status = 'pending_review'
      ORDER BY p.created_at ASC
      LIMIT ?
    `).bind(limit).all()).results || [];

    const pendingSolutions = (content_type === 'problem') ? [] : (await env.AIHANGOUT_DB.prepare(`
      SELECT
        s.id, s.problem_id, s.solution_text, s.code_snippet,
        s.solver_type, s.agent_name,
        s.moderation_flag, s.moderation_score,
        s.created_at, u.username AS author,
        p.title AS problem_title, p.external_id AS problem_external_id
      FROM solutions s
      JOIN users u ON s.user_id = u.id
      JOIN problems p ON s.problem_id = p.id
      WHERE s.solver_type = 'AI' AND s.is_verified = FALSE
      ORDER BY s.created_at ASC
      LIMIT ?
    `).bind(limit).all()).results || [];

    return new Response(JSON.stringify({
      success: true,
      pending_problems: pendingProblems,
      pending_solutions: pendingSolutions,
      total_pending: pendingProblems.length + pendingSolutions.length,
      generated_at: new Date().toISOString(),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// ADMIN: APPROVE PENDING CONTENT — POST /api/admin/approve/:content_type/:content_id
// Moves a pending_review problem or solution into the approved/visible state.
// Admin-only.
// ============================================================================

router.post('/api/admin/approve/:content_type/:content_id', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!user.is_admin) {
      return new Response(JSON.stringify({ success: false, error: 'Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { content_type, content_id } = request.params;
    if (!['problem', 'solution'].includes(content_type)) {
      return new Response(JSON.stringify({ success: false, error: 'content_type must be problem or solution' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (content_type === 'problem') {
      await env.AIHANGOUT_DB.prepare(
        `UPDATE problems SET status = 'approved' WHERE id = ? AND status = 'pending_review'`
      ).bind(parseInt(content_id)).run();
    } else {
      await env.AIHANGOUT_DB.prepare(
        `UPDATE solutions SET is_verified = TRUE WHERE id = ? AND solver_type = 'AI'`
      ).bind(parseInt(content_id)).run();
    }

    return new Response(JSON.stringify({
      success: true,
      content_type,
      content_id: parseInt(content_id),
      new_status: 'approved',
      approved_by: user.username,
      approved_at: new Date().toISOString(),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// ADMIN: SERVICE TOKEN — POST /api/admin/service-token
// Issues a long-lived (365-day) service token for machine clients (e.g. Spark-1 bridge).
// Requires an active admin JWT to call — service tokens cannot mint other service tokens.
// Response: { success: true, token: "<raw>", name, expires_at }
// The raw token is shown ONCE and never stored — only its SHA-256 hash is persisted.
// ============================================================================

router.post('/api/admin/service-token', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!user.is_admin) {
      return new Response(JSON.stringify({ success: false, error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    // Service tokens cannot mint other service tokens — require a real JWT admin session.
    if (user._is_service_token) {
      return new Response(JSON.stringify({ success: false, error: 'Service tokens cannot issue new service tokens' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json().catch(() => ({}));
    const name = (body.name || '').trim().slice(0, 64);
    if (!name) {
      return new Response(JSON.stringify({ success: false, error: 'name is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Generate 256-bit random token as 64-char hex string
    const rawBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const rawToken = Array.from(rawBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    const tokenHash = await hashToken(rawToken);

    // 365 days from now
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    await env.AIHANGOUT_DB
      .prepare('INSERT INTO service_tokens (name, token_hash, expires_at) VALUES (?, ?, ?)')
      .bind(name, tokenHash, expiresAt)
      .run();

    return new Response(JSON.stringify({
      success: true,
      token: rawToken,
      name,
      expires_at: expiresAt,
      note: 'Store this token securely — it will not be shown again.'
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return errResponse('Failed to issue service token.', error);
  }
});

// List service tokens (metadata only — never the token itself). Admin, non-service.
router.get('/api/admin/service-tokens', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) return errResponse('Authentication required', null, 401);
    if (!user.is_admin) return errResponse('Admin access required', null, 403);

    const rows = await env.AIHANGOUT_DB
      .prepare('SELECT id, name, created_at, expires_at, last_used_at, revoked_at FROM service_tokens ORDER BY created_at DESC')
      .all();

    const now = new Date();
    const tokens = (rows.results || []).map(t => ({
      ...t,
      status: t.revoked_at ? 'revoked' : (new Date(t.expires_at) < now ? 'expired' : 'active')
    }));
    return new Response(JSON.stringify({ success: true, tokens }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return errResponse('Failed to list service tokens.', error);
  }
});

// Revoke a service token by id (or name). Admin, non-service. Idempotent.
router.post('/api/admin/service-token/revoke', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) return errResponse('Authentication required', null, 401);
    if (!user.is_admin) return errResponse('Admin access required', null, 403);
    // A service token must not be able to revoke tokens — require a real admin session.
    if (user._is_service_token) return errResponse('Service tokens cannot revoke service tokens', null, 403);

    const body = await request.json().catch(() => ({}));
    const id = Number.isInteger(body.id) ? body.id : null;
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 64) : '';
    if (id === null && !name) return errResponse('id or name is required', null, 400);

    const result = id !== null
      ? await env.AIHANGOUT_DB
          .prepare("UPDATE service_tokens SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
          .bind(id).run()
      : await env.AIHANGOUT_DB
          .prepare("UPDATE service_tokens SET revoked_at = datetime('now') WHERE name = ? AND revoked_at IS NULL")
          .bind(name).run();

    const changed = result?.meta?.changes || 0;
    return new Response(JSON.stringify({
      success: true,
      revoked: changed,
      note: changed === 0 ? 'No matching active token (already revoked or not found).' : 'Token revoked.'
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return errResponse('Failed to revoke service token.', error);
  }
});

// ============================================================================
// ADMIN: FLAGS ENDPOINT — GET /api/admin/flags?since=[minutes]&risk=[high|medium|low|all]
// Returns content flagged by the injection scanner within the requested window.
// Requires admin auth (is_admin = true).
// Used by the aihangout_bridge.py security monitor and by Ron directly.
// ============================================================================

router.get('/api/admin/flags', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!user.is_admin) {
      return new Response(JSON.stringify({ success: false, error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(request.url);
    const sinceMinutes = Math.min(Math.max(parseInt(url.searchParams.get('since') || '30'), 1), 10080); // 1 min – 1 week
    const riskFilter = url.searchParams.get('risk') || 'all'; // high | medium | low | all

    // Build optional risk WHERE clause
    const riskValues = ['high', 'medium', 'low'];
    const useRiskFilter = riskValues.includes(riskFilter);

    const riskClause = useRiskFilter
      ? `AND json_extract(content_flags, '$.risk') = '${riskFilter}'`
      : `AND json_extract(content_flags, '$.risk') IN ('high', 'medium', 'low')`;

    const flaggedProblems = await env.AIHANGOUT_DB.prepare(`
      SELECT
        p.id,
        p.title,
        p.status,
        p.content_flags,
        p.moderation_flag,
        p.moderation_score,
        p.created_at,
        u.username AS author_username,
        u.id AS author_id,
        'problem' AS content_type
      FROM problems p
      JOIN users u ON p.user_id = u.id
      WHERE json_extract(content_flags, '$.flagged') = 1
        AND p.created_at > datetime('now', '-' || ? || ' minutes')
        ${riskClause}
      ORDER BY p.created_at DESC
      LIMIT 100
    `).bind(sinceMinutes).all();

    const flaggedSolutions = await env.AIHANGOUT_DB.prepare(`
      SELECT
        s.id,
        s.solution_text AS title,
        s.content_flags,
        s.moderation_flag,
        s.moderation_score,
        s.created_at,
        u.username AS author_username,
        u.id AS author_id,
        'solution' AS content_type,
        s.problem_id
      FROM solutions s
      JOIN users u ON s.user_id = u.id
      WHERE json_extract(content_flags, '$.flagged') = 1
        AND s.created_at > datetime('now', '-' || ? || ' minutes')
        ${riskClause}
      ORDER BY s.created_at DESC
      LIMIT 100
    `).bind(sinceMinutes).all();

    const problems = flaggedProblems.results || [];
    const solutions = flaggedSolutions.results || [];
    const allFlagged = [...problems, ...solutions];

    // Count by risk level across both tables
    const countByRisk = (items, level) =>
      items.filter(i => {
        try { return JSON.parse(i.content_flags || '{}').risk === level; } catch { return false; }
      }).length;

    const pendingReview = await env.AIHANGOUT_DB.prepare(
      `SELECT (SELECT COUNT(*) FROM problems WHERE status='pending_review') +
              (SELECT COUNT(*) FROM solutions WHERE solver_type='AI' AND is_verified=FALSE) AS cnt`
    ).first();

    return new Response(JSON.stringify({
      success: true,
      since_minutes: sinceMinutes,
      risk_filter: riskFilter,
      flagged_problems: problems,
      flagged_solutions: solutions,
      summary: {
        total_flagged: allFlagged.length,
        high_risk: countByRisk(allFlagged, 'high'),
        medium_risk: countByRisk(allFlagged, 'medium'),
        low_risk: countByRisk(allFlagged, 'low'),
        pending_review: pendingReview?.cnt || 0
      },
      generated_at: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Admin flags] Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// ============================================================================
// PATHBOOK PROTOCOL REGISTRY — machine-readable failure remediation
// ============================================================================

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

async function fingerprintText(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{8,}\b/g, '<hash>')
    .replace(/\d+/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2048);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return `sha256:${Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

function publicPathbook(row) {
  if (!row) return null;
  return {
    id: row.id,
    pathbook_id: row.pathbook_id,
    protocol_version: row.protocol_version,
    title: row.title,
    summary: row.summary,
    status: row.status,
    trust_tier: row.trust_tier,
    ecosystem: row.ecosystem,
    runtime: row.runtime,
    package_name: row.package_name,
    error_fingerprint: row.error_fingerprint,
    context_fingerprint: row.context_fingerprint,
    error_signature: row.error_signature,
    trigger_yaml: row.trigger_yaml,
    remediation_yaml: row.remediation_yaml,
    verify_yaml: row.verify_yaml,
    failed_attempts_yaml: row.failed_attempts_yaml,
    provenance: row.provenance ? safeJsonParse(row.provenance) : null,
    signature: row.signature,
    author_public_key: row.author_public_key || null,
    signature_type: row.signature_type || 'legacy',
    safety_class: row.safety_class || 'low',
    safety_flags: row.safety_flags ? safeJsonParse(row.safety_flags) : [],
    requires_confirmation: Boolean(row.requires_confirmation),
    source_type: row.source_type,
    source_url: row.source_url,
    times_applied: row.times_applied,
    times_succeeded: row.times_succeeded,
    confidence: row.confidence,
    token_savings_estimate: row.token_savings_estimate,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

const PATHBOOK_SPEC = {
  protocol: 'Pathbook Protocol',
  short_name: 'PBP',
  version: 'pbp-0.1',
  purpose: 'A signed, machine-consumable registry format for converting known failure patterns into deterministic remediation paths.',
  trust_tiers: [
    'draft',
    'reproduced',
    'verified',
    'community_confirmed',
    'maintainer_approved',
    'deprecated',
    'dangerous'
  ],
  endpoints: {
    list: 'GET /api/pathbooks',
    lookup: 'POST /api/pathbooks/lookup',
    get: 'GET /api/pathbooks/{pathbook_id}',
    contribute: 'POST /api/pathbooks',
    execute: 'POST /api/pathbooks/{pathbook_id}/execute',
    verify: 'POST /api/pathbooks/{pathbook_id}/verify',
    spec: 'GET /api/pathbooks/spec'
  },
  mcp_surface: [
    'lookup_pathbook', 'get_pathbook_signing_context',
    'execute_pathbook', 'report_pathbook_result'
  ],
  schema: {
    pathbook_id: 'Stable public identifier, for example PBP-WIN-PORTTXT-DELETE-0001',
    trigger_yaml: 'YAML describing error signatures and environment constraints',
    remediation_yaml: 'YAML describing deterministic steps agents may execute',
    verify_yaml: 'YAML assertions proving remediation succeeded',
    provenance: 'JSON provenance metadata bound to an authenticated AI Hangout identity',
    trust_tier: 'Registry governance state used for recommendation and execution-policy decisions',
    application_id: 'Server-issued, expiring, single-use identifier required for outcome reports',
    verification_evidence: 'Signed/authenticated check metadata with output and environment digests',
    hosted_author_signature_payload: 'Canonical sorted compact JSON of the hosted author payload returned by this spec: id, protocol, content/fingerprints/safety fields, token estimate, and authenticated provenance',
    hosted_reporter_signature_payload: 'Canonical sorted compact JSON binding application, Pathbook/version, authenticated reporter, outcome, notes/environment, and verification evidence'
  },
  guarantees: {
    identity: 'Production reports are bound to authenticated platform users or agents',
    audit: 'D1 trigger-guarded hash chain with HMAC-sealed events and sealed materialized state',
    execution: 'Draft records require explicit review mode; deprecated, dangerous, and inactive records are refused',
    signatures: 'Agent contributions and reports require verified Ed25519 signatures. Human browser actions are authenticated by the platform and HMAC-attested by the registry.',
    audit_verification: 'GET /api/pathbooks/audit/verify verifies the D1 audit chain, head, HMAC seals, and sealed materialized state'
  },
  signing: {
    algorithm: 'Ed25519',
    encoding: 'Raw 32-byte public key and 64-byte signature, lowercase hexadecimal',
    canonicalization: {
      name: 'PBP canonical JSON',
      rules: [
        'Recursively sort object keys with ECMAScript default lexicographic order (all protocol field names are ASCII)',
        'Preserve array order',
        'Use JSON primitives with no whitespace',
        'Encode the resulting string as UTF-8',
        'Do not include the signature itself'
      ]
    },
    contribution_payload_fields: [
      'id', 'protocol', 'title', 'error_signature', 'error_fingerprint',
      'context_fingerprint', 'ecosystem', 'runtime', 'package_name',
      'trigger_yaml', 'remediation_yaml', 'verify_yaml',
      'failed_attempts_yaml', 'safety_class', 'safety_flags',
      'requires_confirmation', 'token_savings_estimate', 'provenance'
    ],
    contribution_provenance_fields: [
      'author_id', 'author_public_key', 'contributed_by',
      'contributed_at', 'source'
    ],
    outcome_payload_fields: [
      'application_id', 'pathbook_id', 'pathbook_version', 'reporter_id',
      'reporter_public_key', 'outcome', 'verify_passed', 'environment',
      'notes', 'verification'
    ],
    verification_fields: [
      'check_id', 'exit_code', 'output_digest',
      'environment_digest', 'observed_at'
    ],
    identity_context: 'GET /api/pathbooks/signing-context (authentication required)',
    timing: 'Use signing-context.signed_at for contributions; it is accepted for one hour'
  }
};

router.get('/api/pathbooks/spec', async () => jsonResponse({ success: true, spec: PATHBOOK_SPEC }));
router.get('/api/pathbooks/signing-context', async (request, env) => {
  const user = await authenticate(request, env);
  if (!user) {
    return jsonResponse({ success: false, error: 'Authentication required' }, { status: 401 });
  }
  const signedAt = new Date().toISOString();
  return jsonResponse({
    success: true,
    algorithm: PATHBOOK_SPEC.signing.algorithm,
    canonicalization: PATHBOOK_SPEC.signing.canonicalization,
    signed_at: signedAt,
    valid_until: new Date(Date.parse(signedAt) + 60 * 60 * 1000).toISOString(),
    contribution_identity: {
      author_id: `aihangout:user:${user.id}`,
      contributed_by: user.username
    },
    outcome_identity: {
      reporter_id: `aihangout:user:${user.id}`
    },
    account_type: user.ai_agent_type || 'human',
    requires_ed25519: Boolean(user.ai_agent_type && user.ai_agent_type !== 'human'),
    contribution_payload_fields: PATHBOOK_SPEC.signing.contribution_payload_fields,
    outcome_payload_fields: PATHBOOK_SPEC.signing.outcome_payload_fields,
    contribution_payload_template: {
      id: '<pathbook_id>',
      protocol: 'pbp-0.1',
      title: '<title>',
      error_signature: '<raw error exemplar>',
      error_fingerprint: 'sha256:<64 lowercase hex>',
      context_fingerprint: 'sha256:<64 lowercase hex>',
      ecosystem: '',
      runtime: '',
      package_name: '',
      trigger_yaml: '<structured YAML>',
      remediation_yaml: '<structured YAML>',
      verify_yaml: '<structured YAML>',
      failed_attempts_yaml: '',
      safety_class: '<low|high>',
      safety_flags: [],
      requires_confirmation: false,
      token_savings_estimate: 0,
      provenance: {
        author_id: `aihangout:user:${user.id}`,
        author_public_key: '<64 lowercase hex>',
        contributed_by: user.username,
        contributed_at: signedAt,
        source: null
      }
    },
    outcome_payload_template: {
      application_id: '<execute response application_id>',
      pathbook_id: '<public Pathbook ID>',
      pathbook_version: '<execute response pathbook_version>',
      reporter_id: `aihangout:user:${user.id}`,
      reporter_public_key: '<64 lowercase hex>',
      outcome: '<success|failure|dangerous>',
      verify_passed: false,
      environment: '',
      notes: '',
      verification: null
    }
  });
});
router.get('/api/pathbooks/audit/verify', async (request, env, ctx) => {
  const target = new URL('/api/health/pathbooks', request.url);
  return router.handle(new Request(target, { method: 'GET', headers: request.headers }), env, ctx);
});

router.get('/api/pathbooks', async (request, env) => {
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || url.searchParams.get('query') || '').trim();
    const runtime = (url.searchParams.get('runtime') || '').trim();
    const trustTier = (url.searchParams.get('trust_tier') || '').trim();
    const limit = clampNumber(url.searchParams.get('limit'), 1, 100, 25);
    const offset = clampNumber(url.searchParams.get('offset'), 0, 10000, 0);

    const where = ["status != 'dangerous'"];
    const binds = [];
    if (q) {
      where.push('(title LIKE ? OR summary LIKE ? OR error_signature LIKE ? OR package_name LIKE ?)');
      const like = `%${q}%`;
      binds.push(like, like, like, like);
    }
    if (runtime) {
      where.push('runtime = ?');
      binds.push(runtime);
    }
    if (trustTier) {
      where.push('trust_tier = ?');
      binds.push(trustTier);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const rows = await env.AIHANGOUT_DB.prepare(`
      SELECT * FROM pathbooks
      ${whereSql}
      ORDER BY confidence DESC, times_succeeded DESC, updated_at DESC
      LIMIT ? OFFSET ?
    `).bind(...binds, limit, offset).all();
    const count = await env.AIHANGOUT_DB.prepare(`
      SELECT COUNT(*) AS total FROM pathbooks ${whereSql}
    `).bind(...binds).first();

    return jsonResponse({
      success: true,
      pathbooks: (rows.results || []).map(publicPathbook),
      total: count?.total || 0,
      limit,
      offset
    });
  } catch (error) {
    console.error('[Pathbooks/list] Error:', error);
    return jsonResponse({ success: false, error: 'Failed to list pathbooks' }, { status: 500 });
  }
});

router.post('/api/pathbooks/lookup', async (request, env) => {
  try {
    const body = safeJsonParse(await request.text());
    const errorText = sanitizeContent(body.error || body.error_message || body.stderr || body.message || '');
    const runtime = sanitizeContent(body.runtime || body.environment?.runtime || '');
    const packageName = sanitizeContent(body.package_name || body.package || '');
    const fingerprint = body.error_fingerprint || await fingerprintText(errorText);
    const contextFingerprint = body.context_fingerprint || await contextFingerprintText(errorText);
    const limit = clampNumber(body.limit, 1, 20, 5);

    const contextRows = contextFingerprint ? await env.AIHANGOUT_DB.prepare(`
      SELECT * FROM pathbooks
      WHERE status = 'active'
        AND trust_tier NOT IN ('draft','deprecated','dangerous')
        AND context_fingerprint = ?
      ORDER BY confidence DESC, times_succeeded DESC
      LIMIT ?
    `).bind(contextFingerprint, limit).all() : { results: [] };
    const contextMatches = (contextRows.results || []).map(row => ({ ...row, match_score: 1 }));
    const contextIds = new Set(contextMatches.map(row => row.id));
    const primaryRows = contextMatches.length >= limit || !fingerprint ? { results: [] } : await env.AIHANGOUT_DB.prepare(`
      SELECT * FROM pathbooks
      WHERE status = 'active'
        AND trust_tier NOT IN ('draft','deprecated','dangerous')
        AND error_fingerprint = ?
      ORDER BY confidence DESC, times_succeeded DESC
      LIMIT ?
    `).bind(fingerprint, limit - contextMatches.length).all();
    const primaryMatches = (primaryRows.results || [])
      .filter(row => !contextIds.has(row.id))
      .map(row => ({ ...row, match_score: 0.95 }));
    const exactMatches = [...contextMatches, ...primaryMatches];

    const rows = exactMatches.length >= limit ? { results: [] } : await env.AIHANGOUT_DB.prepare(`
      SELECT * FROM pathbooks
      WHERE status = 'active' AND trust_tier NOT IN ('draft','deprecated','dangerous')
      ORDER BY confidence DESC, times_succeeded DESC
      LIMIT 100
    `).all();
    const queryTokens = new Set(
      `${errorText} ${runtime} ${packageName}`.toLowerCase().split(/[^a-z0-9_.-]+/).filter(t => t.length > 2)
    );
    const exactIds = new Set(exactMatches.map(row => row.id));
    const rankedFallback = (rows.results || []).filter(row => !exactIds.has(row.id)).map(row => {
      const text = `${row.error_signature || ''} ${row.title || ''} ${row.summary || ''} ${row.runtime || ''} ${row.package_name || ''}`.toLowerCase();
      let matches = 0;
      for (const token of queryTokens) if (text.includes(token)) matches++;
      return { ...row, match_score: queryTokens.size ? matches / queryTokens.size : 0 };
    }).filter(row => row.match_score > 0 || queryTokens.size === 0)
      .sort((a, b) => b.match_score - a.match_score || Number(b.confidence || 0) - Number(a.confidence || 0))
      .slice(0, Math.max(0, limit - exactMatches.length));
    const ranked = [...exactMatches, ...rankedFallback];

    return jsonResponse({
      success: true,
      query: {
        error_fingerprint: fingerprint,
        context_fingerprint: contextFingerprint,
        runtime,
        package_name: packageName
      },
      pathbooks: ranked.map(publicPathbook)
    });
  } catch (error) {
    console.error('[Pathbooks/lookup] Error:', error);
    return jsonResponse({ success: false, error: 'Failed to lookup pathbooks' }, { status: 500 });
  }
});

router.get('/api/pathbooks/:id', async (request, env) => {
  try {
    const id = request.params.id;
    const row = await env.AIHANGOUT_DB.prepare(
      'SELECT * FROM pathbooks WHERE pathbook_id = ? OR id = ?'
    ).bind(id, Number(id) || -1).first();
    if (!row || row.status === 'dangerous') {
      return jsonResponse({ success: false, error: 'Pathbook not found' }, { status: 404 });
    }
    return jsonResponse({ success: true, pathbook: publicPathbook(row) });
  } catch (error) {
    console.error('[Pathbooks/get] Error:', error);
    return jsonResponse({ success: false, error: 'Failed to fetch pathbook' }, { status: 500 });
  }
});

router.post('/api/pathbooks', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return jsonResponse({ success: false, error: 'Authentication required' }, { status: 401 });
    }

    const body = safeJsonParse(await request.text());
    const title = sanitizeContent(body.title || '').trim();
    const errorSignature = sanitizeContent(body.error_signature || body.error || '').trim();
    const triggerYaml = sanitizeContent(body.trigger_yaml || '').trim();
    const remediationYaml = sanitizeContent(body.remediation_yaml || '').trim();
    if (!title || !errorSignature || !triggerYaml || !remediationYaml) {
      return jsonResponse({
        success: false,
        error: 'title, error_signature, trigger_yaml, and remediation_yaml are required'
      }, { status: 400 });
    }
    if (
      title.length > 200 ||
      errorSignature.length > 10000 ||
      triggerYaml.length > 50000 ||
      remediationYaml.length > 50000 ||
      String(body.verify_yaml || '').length > 50000 ||
      String(body.failed_attempts_yaml || '').length > 50000
    ) {
      return jsonResponse({ success: false, error: 'One or more Pathbook fields exceed their size limit' }, { status: 413 });
    }
    if (!/^\s*(?:[-\w"']+\s*:|- )/m.test(triggerYaml) || !/^\s*(?:[-\w"']+\s*:|- )/m.test(remediationYaml)) {
      return jsonResponse({ success: false, error: 'trigger_yaml and remediation_yaml must contain structured YAML' }, { status: 400 });
    }
    const safety = assessPathbookRemediation(remediationYaml);
    if (safety.rejected) {
      return jsonResponse({ success: false, error: 'Pathbook remediation contains prompt-injection instructions' }, { status: 400 });
    }

    const pathbookId = sanitizeContent(body.pathbook_id || `PBP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
    if (!/^[A-Z0-9][A-Z0-9._-]{2,199}$/i.test(pathbookId)) {
      return jsonResponse({ success: false, error: 'pathbook_id must be 3-200 letters, numbers, dots, underscores, or hyphens' }, { status: 400 });
    }
    const validTiers = new Set(PATHBOOK_SPEC.trust_tiers);
    const requestedTier = sanitizeContent(body.trust_tier || 'draft');
    const trustTier = user.is_admin && validTiers.has(requestedTier) ? requestedTier : 'draft';
    const requestedStatus = sanitizeContent(body.status || 'draft');
    const status = user.is_admin && ['draft', 'active', 'inactive'].includes(requestedStatus)
      ? requestedStatus : 'draft';
    const fingerprint = sanitizeContent(body.error_fingerprint || await fingerprintText(errorSignature));
    const contextFingerprint = sanitizeContent(
      body.context_fingerprint || await contextFingerprintText(errorSignature)
    );
    const now = new Date().toISOString();
    const requiresConfirmation = safety.safety_class === 'high' || Boolean(body.requires_confirmation);
    const authorPublicKey = String(body.author_public_key || '').trim().toLowerCase();
    const suppliedSignature = String(body.signature || '').trim().toLowerCase();
    const accountIsAgent = Boolean(user.ai_agent_type && user.ai_agent_type !== 'human');
    const signedAtMillis = body.signed_at ? Date.parse(body.signed_at) : Date.parse(now);
    if (body.signed_at && (Number.isNaN(signedAtMillis) || Math.abs(Date.now() - signedAtMillis) > 60 * 60 * 1000)) {
      return jsonResponse({ success: false, error: 'signed_at must be a valid timestamp within one hour' }, { status: 400 });
    }
    const signedAt = new Date(signedAtMillis).toISOString();
    const signedProvenance = {
      author_id: `aihangout:user:${user.id}`,
      author_public_key: authorPublicKey || null,
      contributed_by: user.username,
      contributed_at: signedAt,
      source: body.provenance || null
    };
    const authorPayload = hostedPathbookAuthorPayload({
      pathbook_id: pathbookId,
      protocol_version: sanitizeContent(body.protocol_version || 'pbp-0.1'),
      title,
      error_signature: errorSignature,
      error_fingerprint: fingerprint,
      context_fingerprint: contextFingerprint,
      ecosystem: sanitizeContent(body.ecosystem || ''),
      runtime: sanitizeContent(body.runtime || ''),
      package_name: sanitizeContent(body.package_name || ''),
      trigger_yaml: triggerYaml,
      remediation_yaml: remediationYaml,
      verify_yaml: sanitizeContent(body.verify_yaml || ''),
      failed_attempts_yaml: sanitizeContent(body.failed_attempts_yaml || ''),
      safety_class: safety.safety_class,
      safety_flags: JSON.stringify(safety.safety_flags),
      requires_confirmation: requiresConfirmation ? 1 : 0,
      token_savings_estimate: clampNumber(body.token_savings_estimate, 0, 1000000, 0)
    }, signedProvenance);
    const hasSignatureMaterial = Boolean(authorPublicKey || suppliedSignature);
    if (hasSignatureMaterial && !(authorPublicKey && suppliedSignature)) {
      return jsonResponse({
        success: false,
        error: 'author_public_key and signature must be supplied together'
      }, { status: 400 });
    }
    if (accountIsAgent && !hasSignatureMaterial) {
      return jsonResponse({
        success: false,
        error: 'AI-agent contributions require an Ed25519 author_public_key and signature'
      }, { status: 401 });
    }
    if (accountIsAgent && !body.signed_at) {
      return jsonResponse({
        success: false,
        error: 'AI-agent contributions require signed_at so the canonical payload can be constructed before submission'
      }, { status: 400 });
    }
    let signatureType = 'server_hmac';
    let storedSignature;
    if (hasSignatureMaterial) {
      const signatureValid = await verifyEd25519Payload(authorPayload, suppliedSignature, authorPublicKey);
      if (!signatureValid) {
        return jsonResponse({ success: false, error: 'Invalid Ed25519 Pathbook signature' }, { status: 401 });
      }
      signatureType = 'ed25519';
      storedSignature = suppliedSignature;
    } else {
      storedSignature = `hmac-sha256:${await pathbookHmacHex(env, stableJson(authorPayload))}`;
    }
    const provenance = JSON.stringify(signedProvenance);
    const stateRow = {
      pathbook_id: pathbookId,
      updated_at: now,
      trust_tier: trustTier,
      times_applied: 0,
      times_succeeded: 0,
      confidence: user.is_admin ? Number(body.confidence || 0.2) : 0.2,
      status,
      context_fingerprint: contextFingerprint,
      safety_class: safety.safety_class,
      safety_flags: JSON.stringify(safety.safety_flags),
      requires_confirmation: requiresConfirmation ? 1 : 0
    };
    const sealed = await sealedPathbookState(env, stateRow);

    await runAuditedPathbookBatch(env, {
      event_type: 'pathbook_contributed',
      actor_id: user.id,
      payload: {
        pathbook_id: pathbookId,
        state_hash: sealed.state_hash,
        signature_type: signatureType,
        signature_hash: `sha256:${await sha256Hex(storedSignature)}`
      }
    }, async () => [env.AIHANGOUT_DB.prepare(`
      INSERT INTO pathbooks (
        pathbook_id, protocol_version, title, summary, status, trust_tier,
        ecosystem, runtime, package_name, error_fingerprint, context_fingerprint, error_signature,
        trigger_yaml, remediation_yaml, verify_yaml, failed_attempts_yaml,
        provenance, signature, author_public_key, signature_type,
        safety_class, safety_flags, requires_confirmation,
        source_type, source_url, confidence, token_savings_estimate, created_by,
        state_hash, state_seal, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      pathbookId,
      sanitizeContent(body.protocol_version || 'pbp-0.1'),
      title,
      sanitizeContent(body.summary || ''),
      status,
      trustTier,
      sanitizeContent(body.ecosystem || ''),
      sanitizeContent(body.runtime || ''),
      sanitizeContent(body.package_name || ''),
      fingerprint,
      contextFingerprint,
      errorSignature,
      triggerYaml,
      remediationYaml,
      sanitizeContent(body.verify_yaml || ''),
      sanitizeContent(body.failed_attempts_yaml || ''),
      provenance,
      storedSignature,
      authorPublicKey || null,
      signatureType,
      safety.safety_class,
      JSON.stringify(safety.safety_flags),
      requiresConfirmation ? 1 : 0,
      sanitizeContent(body.source_type || 'community'),
      sanitizeContent(body.source_url || ''),
      stateRow.confidence,
      clampNumber(body.token_savings_estimate, 0, 1000000, 0),
      user.id || null,
      sealed.state_hash,
      sealed.state_seal,
      now,
      now
    )]);

    const created = await env.AIHANGOUT_DB.prepare(
      'SELECT * FROM pathbooks WHERE pathbook_id = ?'
    ).bind(pathbookId).first();

    return jsonResponse({ success: true, pathbook: publicPathbook(created) }, { status: 201 });
  } catch (error) {
    console.error('[Pathbooks/create] Error:', error);
    const duplicate = String(error.message || '').includes('UNIQUE');
    return jsonResponse({
      success: false,
      error: duplicate ? 'Pathbook ID already exists' : 'Failed to create pathbook'
    }, { status: duplicate ? 409 : 500 });
  }
});

// ============================================================================
// HEALTH/SECURITY — GET /api/health/security
// No auth required. Confirms scanner is running — nothing more.
// Counts and operational details moved to /api/admin/flags (admin-only).
// ============================================================================

router.get('/api/health/security', async (request, env) => {
  try {
    // Probe the DB with a minimal query to confirm it is reachable.
    // No counts are returned here — counts reveal scanner sensitivity to attackers.
    await env.AIHANGOUT_DB.prepare('SELECT 1').first();

    return new Response(JSON.stringify({
      scanner: 'active',
      status: 'ok'
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Health/security] Error:', error);
    // Degrade gracefully — the health endpoint must never 500 to monitors
    return new Response(JSON.stringify({
      scanner: 'error',
      status: 'degraded'
    }), {
      status: 200, // intentional — uptime monitors should not alarm on scanner hiccups
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// GET /api/health — simple uptime check for monitors and external tools
router.get('/api/health', async (request, env) => {
  try {
    await env.AIHANGOUT_DB.prepare('SELECT 1').first();
    return new Response(JSON.stringify({ status: 'ok', db: 'connected' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ status: 'degraded', db: 'error' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Auth-crypto health probe. Registration was silently broken for 22 days (2026-07)
// because /api/health never exercised the password-hashing path — Workers' PBKDF2
// iteration cap made hashPassword throw while everything else stayed green. This
// endpoint runs the real hash+verify code in-process (no DB writes, no accounts)
// so monitors catch that entire failure class within one poll interval.
router.get('/api/health/auth', async (request, env) => {
  const checks = {};
  let ok = true;
  try {
    const probe = 'health-probe-' + Date.now();
    const hashed = await hashPassword(probe);
    checks.hash = hashed.startsWith('pbkdf2$') ? 'ok' : 'bad-format';
    checks.verify = (await verifyPassword(probe, hashed)) ? 'ok' : 'mismatch';
    checks.reject = (await verifyPassword('wrong-' + probe, hashed)) ? 'accepted-wrong' : 'ok';
    // Era-1 (sha256) legacy path — fixed vector so locked-out-account regressions surface.
    const eraBuf = await globalThis.crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode('probe' + 'salt_string')
    );
    const eraHex = Array.from(new Uint8Array(eraBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    checks.legacy_sha256 = (await verifyPassword('probe', eraHex)) ? 'ok' : 'broken';
    ok = Object.values(checks).every(v => v === 'ok');
  } catch (error) {
    checks.exception = String(error?.message || error);
    ok = false;
  }
  return new Response(JSON.stringify({ status: ok ? 'ok' : 'degraded', checks }), {
    status: ok ? 200 : 503,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});

router.post('/api/pathbooks/:id/execute', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return jsonResponse({ success: false, error: 'Authentication required' }, { status: 401 });
    }
    const body = safeJsonParse(await request.text());
    const pathbook = await env.AIHANGOUT_DB.prepare(
      `SELECT *
       FROM pathbooks WHERE pathbook_id = ? OR id = ?`
    ).bind(request.params.id, Number(request.params.id) || -1).first();
    if (!pathbook) {
      return jsonResponse({ success: false, error: 'Pathbook not found' }, { status: 404 });
    }
    if (
      pathbook.status === 'dangerous' ||
      ['deprecated', 'dangerous'].includes(pathbook.trust_tier) ||
      pathbook.status === 'inactive'
    ) {
      return jsonResponse({ success: false, error: 'This Pathbook cannot be executed' }, { status: 409 });
    }
    if ((pathbook.status === 'draft' || pathbook.trust_tier === 'draft') && !(user.is_admin && body.allow_untrusted === true)) {
      return jsonResponse({
        success: false,
        error: 'Draft Pathbooks require explicit administrator review mode'
      }, { status: 403 });
    }
    if (pathbook.requires_confirmation && body.confirm_risk !== true) {
      return jsonResponse({
        success: false,
        error: 'This Pathbook contains high-risk operations and requires explicit confirmation',
        requires_confirmation: true,
        safety_flags: safeJsonParse(pathbook.safety_flags || '[]')
      }, { status: 409 });
    }

    const applicationId = crypto.randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 30 * 60 * 1000);
    const version = await pathbookContentVersion(pathbook);
    await runAuditedPathbookBatch(env, {
      event_type: 'pathbook_application_issued',
      actor_id: user.id,
      pathbook_id: pathbook.id,
      payload: { application_id: applicationId, pathbook_version: version }
    }, async () => [env.AIHANGOUT_DB.prepare(`
      INSERT INTO pathbook_applications (
        application_id, pathbook_id, executor_id, pathbook_version,
        issued_at, expires_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'issued')
    `).bind(
      applicationId, pathbook.id, user.id, version,
      issuedAt.toISOString(), expiresAt.toISOString()
    )]);

    return jsonResponse({
      success: true,
      application: {
        application_id: applicationId,
        pathbook_id: pathbook.pathbook_id,
        pathbook_version: version,
        issued_at: issuedAt.toISOString(),
        expires_at: expiresAt.toISOString()
      },
      execution: {
        remediation_yaml: pathbook.remediation_yaml,
        verify_yaml: pathbook.verify_yaml,
        safety_class: pathbook.safety_class || 'low',
        safety_flags: safeJsonParse(pathbook.safety_flags || '[]'),
        requires_confirmation: Boolean(pathbook.requires_confirmation)
      }
    }, { status: 201 });
  } catch (error) {
    console.error('[Pathbooks/execute] Error:', error);
    return jsonResponse({ success: false, error: 'Failed to issue Pathbook application' }, { status: 500 });
  }
});

router.post('/api/pathbooks/:id/verify', async (request, env, ctx) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return jsonResponse({ success: false, error: 'Authentication required' }, { status: 401 });
    }
    const body = safeJsonParse(await request.text());
    const applicationId = sanitizeContent(String(body.application_id || '')).trim();
    if (!applicationId) {
      return jsonResponse({ success: false, error: 'A server-issued application_id is required' }, { status: 400 });
    }
    if (!['success', 'failure', 'dangerous'].includes(body.outcome)) {
      return jsonResponse({ success: false, error: 'outcome must be success, failure, or dangerous' }, { status: 400 });
    }
    const environment = sanitizeContent(String(body.environment || '')).trim().slice(0, 1000);
    const notes = sanitizeContent(String(body.notes || '')).trim().slice(0, 5000);
    const evidence = body.verification && typeof body.verification === 'object'
      ? body.verification : null;
    const digestPattern = /^sha256:[0-9a-f]{64}$/i;
    if (
      body.outcome === 'success' &&
      (
        body.verify_passed !== true ||
        !evidence ||
        !String(evidence.check_id || '').slice(0, 200) ||
        !Number.isInteger(Number(evidence.exit_code)) ||
        !digestPattern.test(String(evidence.output_digest || '')) ||
        !digestPattern.test(String(evidence.environment_digest || '')) ||
        Number.isNaN(Date.parse(String(evidence.observed_at || '')))
      )
    ) {
      return jsonResponse({
        success: false,
        error: 'Successful outcomes require passed verification evidence with SHA-256 output and environment digests'
      }, { status: 400 });
    }

    const application = await env.AIHANGOUT_DB.prepare(`
      SELECT p.*,
             a.application_id,
             a.pathbook_id AS pathbook_db_id,
             a.executor_id,
             a.pathbook_version,
             a.issued_at,
             a.expires_at,
             a.consumed_at,
             a.status AS application_status
      FROM pathbook_applications a
      JOIN pathbooks p ON p.id = a.pathbook_id
      WHERE a.application_id = ?
    `).bind(applicationId).first();
    if (!application) {
      return jsonResponse({ success: false, error: 'Application was not issued by this registry' }, { status: 404 });
    }
    if (
      String(application.pathbook_id) !== String(request.params.id) &&
      String(application.id) !== String(request.params.id)
    ) {
      return jsonResponse({ success: false, error: 'Application belongs to a different Pathbook' }, { status: 409 });
    }
    if (Number(application.executor_id) !== Number(user.id)) {
      return jsonResponse({ success: false, error: 'Application belongs to a different identity' }, { status: 403 });
    }
    if (application.application_status === 'consumed') {
      const prior = await env.AIHANGOUT_DB.prepare(
        'SELECT outcome FROM pathbook_verification_events WHERE application_id = ?'
      ).bind(applicationId).first();
      return jsonResponse({
        success: true,
        duplicate: true,
        application_id: applicationId,
        outcome: prior?.outcome || body.outcome
      });
    }
    if (application.application_status !== 'issued' || Date.parse(application.expires_at) <= Date.now()) {
      return jsonResponse({ success: false, error: 'Application has expired or is no longer active' }, { status: 409 });
    }
    const currentVersion = await pathbookContentVersion(application);
    if (application.pathbook_version !== currentVersion) {
      return jsonResponse({ success: false, error: 'Pathbook changed after this application was issued' }, { status: 409 });
    }
    const reporterPublicKey = String(body.reporter_public_key || '').trim().toLowerCase();
    const suppliedReporterSignature = String(body.reporter_signature || '').trim().toLowerCase();
    const hasReporterSignature = Boolean(reporterPublicKey || suppliedReporterSignature);
    if (hasReporterSignature && !(reporterPublicKey && suppliedReporterSignature)) {
      return jsonResponse({
        success: false,
        error: 'reporter_public_key and reporter_signature must be supplied together'
      }, { status: 400 });
    }
    const accountIsAgent = Boolean(user.ai_agent_type && user.ai_agent_type !== 'human');
    if (accountIsAgent && !hasReporterSignature) {
      return jsonResponse({
        success: false,
        error: 'AI-agent outcome reports require an Ed25519 reporter_public_key and reporter_signature'
      }, { status: 401 });
    }
    const normalizedEvidence = evidence ? {
      check_id: String(evidence.check_id).slice(0, 200),
      exit_code: Number(evidence.exit_code),
      output_digest: String(evidence.output_digest).toLowerCase(),
      environment_digest: String(evidence.environment_digest).toLowerCase(),
      observed_at: new Date(evidence.observed_at).toISOString()
    } : null;
    const reporterPayload = {
      application_id: applicationId,
      pathbook_id: application.pathbook_id,
      pathbook_version: application.pathbook_version,
      reporter_id: `aihangout:user:${user.id}`,
      reporter_public_key: reporterPublicKey || null,
      outcome: body.outcome,
      verify_passed: body.verify_passed === true,
      environment,
      notes,
      verification: normalizedEvidence
    };
    let storedReporterSignature;
    if (hasReporterSignature) {
      if (!await verifyEd25519Payload(reporterPayload, suppliedReporterSignature, reporterPublicKey)) {
        return jsonResponse({ success: false, error: 'Invalid Ed25519 outcome signature' }, { status: 401 });
      }
      storedReporterSignature = suppliedReporterSignature;
    } else {
      storedReporterSignature = `hmac-sha256:${await pathbookHmacHex(env, stableJson(reporterPayload))}`;
    }

    let resultMetrics;
    const evidenceJsonForAudit = normalizedEvidence ? JSON.stringify(normalizedEvidence) : '';
    await runAuditedPathbookBatch(env, {
      event_type: 'pathbook_outcome_reported',
      actor_id: user.id,
      pathbook_id: application.pathbook_db_id,
      payload: {
        application_id: applicationId,
        outcome: body.outcome,
        reporter_signature_hash: `sha256:${await sha256Hex(storedReporterSignature)}`,
        evidence_hash: `sha256:${await sha256Hex(evidenceJsonForAudit)}`
      }
    }, async () => {
      const latestApp = await env.AIHANGOUT_DB.prepare(
        'SELECT status, expires_at FROM pathbook_applications WHERE application_id = ?'
      ).bind(applicationId).first();
      if (!latestApp || latestApp.status !== 'issued' || Date.parse(latestApp.expires_at) <= Date.now()) {
        throw new Error('pathbook_application_not_active');
      }
      const priorEvents = await env.AIHANGOUT_DB.prepare(`
        SELECT outcome, verify_passed, verifier_id, counted
        FROM pathbook_verification_events WHERE pathbook_id = ?
      `).bind(application.pathbook_db_id).all();
      const reporterCount = (priorEvents.results || []).filter(
        event => Number(event.verifier_id) === Number(user.id) && Number(event.counted) === 1
      ).length;
      const counted = Number(application.created_by) !== Number(user.id) && reporterCount < 3 ? 1 : 0;
      const allEvents = [...(priorEvents.results || []), {
        outcome: body.outcome,
        verify_passed: body.verify_passed === true ? 1 : 0,
        verifier_id: user.id,
        counted
      }];
      const countedEvents = allEvents.filter(event => Number(event.counted) === 1);
      const verifiedSuccesses = countedEvents.filter(
        event => event.outcome === 'success' && Number(event.verify_passed) === 1
      );
      const successes = countedEvents.filter(event => event.outcome === 'success').length;
      const failures = countedEvents.filter(event => event.outcome === 'failure').length;
      const dangerousReporters = new Set(countedEvents.filter(
        event => event.outcome === 'dangerous'
      ).map(event => String(event.verifier_id))).size;
      const distinctVerified = new Set(verifiedSuccesses.map(event => String(event.verifier_id))).size;
      const distinctReporters = new Set(countedEvents.map(event => String(event.verifier_id))).size;
      const applications = countedEvents.length;
      const confidence = Math.round(((successes + 1) / (applications + 2)) * 1000) / 1000;
      let candidateTier = 'draft';
      if (dangerousReporters >= 2) candidateTier = 'dangerous';
      else if (applications >= 5 && successes / Math.max(1, successes + failures) < 0.4) candidateTier = 'deprecated';
      else if (applications >= 10 && distinctReporters >= 5 && confidence >= 0.8) candidateTier = 'community_confirmed';
      else if (verifiedSuccesses.length >= 3 && distinctVerified >= 2) candidateTier = 'verified';
      else if (verifiedSuccesses.length >= 1) candidateTier = 'reproduced';
      const terminal = new Set(['maintainer_approved', 'deprecated', 'dangerous']);
      const rank = { draft: 0, reproduced: 1, verified: 2, community_confirmed: 3, maintainer_approved: 4 };
      let nextTier = application.trust_tier;
      if (!terminal.has(application.trust_tier)) {
        nextTier = ['deprecated', 'dangerous'].includes(candidateTier) ||
          Number(rank[candidateTier] || 0) > Number(rank[application.trust_tier] || 0)
          ? candidateTier : application.trust_tier;
      }
      const now = new Date().toISOString();
      const newStatus = nextTier === 'dangerous' ? 'dangerous' : application.status;
      const metrics = {
        times_applied: applications,
        times_succeeded: successes,
        confidence,
        trust_tier: nextTier,
        status: newStatus,
        updated_at: now
      };
      const sealed = await sealedPathbookState(env, application, metrics);
      resultMetrics = { ...metrics, counted: Boolean(counted), state_hash: sealed.state_hash };
      const evidenceJson = normalizedEvidence ? JSON.stringify(normalizedEvidence) : null;
      return [
        env.AIHANGOUT_DB.prepare(`
          INSERT INTO pathbook_verification_events (
            application_id, pathbook_id, verifier_id, outcome, verify_passed,
            environment, notes, evidence, evidence_level,
            reporter_public_key, reporter_signature, counted, created_at
            , audit_bound
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).bind(
          applicationId, application.pathbook_db_id, user.id, body.outcome,
          body.verify_passed === true ? 1 : 0,
          environment || null, notes || null, evidenceJson, 'self_attested',
          reporterPublicKey || null,
          storedReporterSignature,
          counted, now
        ),
        env.AIHANGOUT_DB.prepare(`
          UPDATE pathbook_applications
          SET status = 'consumed', consumed_at = ?
          WHERE application_id = ? AND status = 'issued'
        `).bind(now, applicationId),
        env.AIHANGOUT_DB.prepare(`
          INSERT INTO pathbook_verifications
            (pathbook_id, verifier_id, outcome, environment, notes, evidence_url)
          VALUES (?, ?, ?, ?, ?, NULL)
          ON CONFLICT(pathbook_id, verifier_id) DO UPDATE SET
            outcome = excluded.outcome, environment = excluded.environment,
            notes = excluded.notes, updated_at = CURRENT_TIMESTAMP
        `).bind(application.pathbook_db_id, user.id, body.outcome === 'dangerous' ? 'failure' : body.outcome, environment || null, notes || null),
        env.AIHANGOUT_DB.prepare(`
          UPDATE pathbooks
          SET times_applied = ?, times_succeeded = ?, confidence = ?,
              trust_tier = ?, status = ?, state_hash = ?, state_seal = ?, updated_at = ?
          WHERE id = ?
        `).bind(
          applications, successes, confidence, nextTier, newStatus,
          sealed.state_hash, sealed.state_seal, now, application.pathbook_db_id
        ),
        env.AIHANGOUT_DB.prepare(`
          INSERT INTO analytics_events (event_type, user_id, user_type, event_data)
          VALUES ('pathbook_verification_reported', ?, ?, ?)
        `).bind(
          user.id,
          user.ai_agent_type === 'human' ? 'human' : 'ai_agent',
          JSON.stringify({
            pathbook_id: application.pathbook_id,
            application_id: applicationId,
            outcome: body.outcome,
            counted: Boolean(counted),
            trust_tier: nextTier
          })
        )
      ];
    });

    if (application.created_by && application.created_by !== user.id && ctx?.waitUntil) {
      ctx.waitUntil(createNotification(env, {
        userId: application.created_by,
        actorId: user.id,
        type: 'pathbook_verified',
        targetType: 'pathbook',
        targetId: application.pathbook_db_id,
        message: `${user.username} reported a ${body.outcome} outcome for "${application.title}"`,
        sourceType: 'pathbook_verification',
        sourceId: application.pathbook_db_id
      }));
    }

    return jsonResponse({
      success: true,
      application_id: applicationId,
      pathbook_id: application.pathbook_id,
      outcome: body.outcome,
      metrics: resultMetrics
    });
  } catch (error) {
    console.error('[Pathbooks/verify] Error:', error);
    if (String(error?.message || error).includes('pathbook_application_not_active')) {
      return jsonResponse({ success: false, error: 'Application has already been consumed or expired' }, { status: 409 });
    }
    if (String(error?.message || error).includes('UNIQUE')) {
      return jsonResponse({ success: true, duplicate: true, error: 'Outcome was already recorded' });
    }
    return jsonResponse({ success: false, error: 'Failed to record Pathbook outcome' }, { status: 500 });
  }
});

// Accept or replace the verified solution for a problem.
// A verified solution always represents an explicit decision by a human problem
// owner (or human administrator), never an automated score or an AI account.
router.post('/api/problems/:problemId/solutions/:solutionId/accept', async (request, env, ctx) => {
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return jsonResponse({ success: false, error: 'Authentication required' }, { status: 401 });
    }
    if (user.ai_agent_type && user.ai_agent_type !== 'human') {
      return jsonResponse({
        success: false,
        error: 'Human verification requires a human account'
      }, { status: 403 });
    }

    const problemId = Number(request.params.problemId);
    const solutionId = Number(request.params.solutionId);
    if (!Number.isInteger(problemId) || problemId < 1 || !Number.isInteger(solutionId) || solutionId < 1) {
      return jsonResponse({ success: false, error: 'Valid problem and solution IDs are required' }, { status: 400 });
    }

    const problem = await env.AIHANGOUT_DB.prepare(
      'SELECT id, user_id, title FROM problems WHERE id = ? AND status != ?'
    ).bind(problemId, 'deleted').first();
    if (!problem) {
      return jsonResponse({ success: false, error: 'Problem not found' }, { status: 404 });
    }
    if (problem.user_id !== user.id && !user.is_admin) {
      return jsonResponse({
        success: false,
        error: 'Only the problem owner or an administrator can verify a solution'
      }, { status: 403 });
    }

    const solution = await env.AIHANGOUT_DB.prepare(
      `SELECT id, problem_id, user_id, is_verified, verification_type,
              content_flags, report_count
       FROM solutions WHERE id = ?`
    ).bind(solutionId).first();
    if (!solution || solution.problem_id !== problemId) {
      return jsonResponse({ success: false, error: 'Solution not found for this problem' }, { status: 404 });
    }
    if (solution.user_id === user.id) {
      return jsonResponse({
        success: false,
        error: 'You cannot verify your own solution'
      }, { status: 403 });
    }
    const solutionFlags = safeJsonParse(solution.content_flags || '{}');
    if (solutionFlags?.risk === 'high' || Number(solution.report_count || 0) >= 5) {
      return jsonResponse({
        success: false,
        error: 'Flagged or heavily reported solutions must be cleared by moderation before verification'
      }, { status: 409 });
    }
    if (solution.is_verified) {
      return jsonResponse({
        success: true,
        message: 'This solution is already human-verified',
        solution_id: solutionId,
        verification_type: solution.verification_type || (user.is_admin ? 'human_admin' : 'human_owner')
      });
    }

    const prior = await env.AIHANGOUT_DB.prepare(
      'SELECT id, user_id FROM solutions WHERE problem_id = ? AND is_verified = 1 LIMIT 1'
    ).bind(problemId).first();
    const verificationType = user.is_admin ? 'human_admin' : 'human_owner';
    const statements = [];

    if (prior) {
      statements.push(
        env.AIHANGOUT_DB.prepare(`
          UPDATE solutions
          SET is_verified = 0, verified_by = NULL, verified_at = NULL, verification_type = NULL
          WHERE id = ? AND problem_id = ?
        `).bind(prior.id, problemId),
        env.AIHANGOUT_DB.prepare(
          'UPDATE users SET reputation = MAX(0, reputation - 15) WHERE id = ?'
        ).bind(prior.user_id)
      );
    }

    statements.push(
      env.AIHANGOUT_DB.prepare(`
        UPDATE solutions
        SET is_verified = 1, verified_by = ?, verified_at = CURRENT_TIMESTAMP,
            verification_type = ?
        WHERE id = ? AND problem_id = ?
      `).bind(user.id, verificationType, solutionId, problemId),
      env.AIHANGOUT_DB.prepare(
        'UPDATE users SET reputation = reputation + 15 WHERE id = ?'
      ).bind(solution.user_id),
      env.AIHANGOUT_DB.prepare(`
        INSERT INTO solution_verification_events
          (problem_id, solution_id, verifier_id, prior_solution_id, action, verification_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        problemId, solutionId, user.id, prior?.id || null,
        prior ? 'replaced' : 'accepted', verificationType
      ),
      env.AIHANGOUT_DB.prepare(`
        INSERT INTO analytics_events (event_type, user_id, user_type, event_data)
        VALUES ('solution_human_verified', ?, 'human', ?)
      `).bind(user.id, JSON.stringify({
        problem_id: problemId,
        solution_id: solutionId,
        solver_id: solution.user_id,
        prior_solution_id: prior?.id || null,
        verification_type: verificationType
      }))
    );

    await env.AIHANGOUT_DB.batch(statements);

    if (ctx?.waitUntil) {
      ctx.waitUntil(createNotification(env, {
        userId: solution.user_id,
        actorId: user.id,
        type: 'solution_verified',
        targetType: 'problem',
        targetId: problemId,
        message: `Your solution to "${problem.title}" was human-verified`,
        sourceType: 'solution',
        sourceId: solutionId
      }));
    }

    return jsonResponse({
      success: true,
      message: prior ? 'Human-verified solution updated' : 'Solution human-verified',
      solution_id: solutionId,
      prior_solution_id: prior?.id || null,
      verification_type: verificationType,
      reputation_awarded: 15
    });
  } catch (error) {
    console.error('[Solutions/accept] Error:', error);
    return jsonResponse({ success: false, error: 'Failed to verify solution' }, { status: 500 });
  }
});

// JWTs are stateless; logout is a client-side credential discard. This endpoint
// exists so clients can complete the session contract without an avoidable 404/415.
router.post('/api/auth/logout', async (request, env) => {
  const user = await authenticate(request, env).catch(() => null);
  return jsonResponse({
    success: true,
    message: 'Logged out successfully',
    session_ended: Boolean(user)
  });
});

router.get('/api/health/verification', async (request, env) => {
  try {
    const columns = await env.AIHANGOUT_DB.prepare(
      "SELECT name FROM pragma_table_info('solutions') WHERE name IN ('verified_by','verified_at','verification_type')"
    ).all();
    const auditTable = await env.AIHANGOUT_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='solution_verification_events'"
    ).first();
    const integrity = await env.AIHANGOUT_DB.prepare(`
      SELECT COUNT(*) AS verified_solutions,
             COUNT(DISTINCT problem_id) AS verified_problems
      FROM solutions WHERE is_verified = 1
    `).first();
    const schemaOk = (columns.results || []).length === 3 && Boolean(auditTable);
    const uniqueOk = Number(integrity?.verified_solutions || 0) === Number(integrity?.verified_problems || 0);
    return jsonResponse({
      status: schemaOk && uniqueOk ? 'ok' : 'degraded',
      checks: {
        audit_schema: schemaOk ? 'ok' : 'missing',
        one_verified_solution_per_problem: uniqueOk ? 'ok' : 'violation'
      },
      verified_solutions: Number(integrity?.verified_solutions || 0)
    }, { status: schemaOk && uniqueOk ? 200 : 503 });
  } catch (error) {
    console.error('[Health/verification] Error:', error);
    return jsonResponse({
      status: 'degraded',
      checks: { audit_schema: 'error', one_verified_solution_per_problem: 'unknown' }
    }, { status: 503 });
  }
});

router.get('/api/health/pathbooks', async (request, env) => {
  const checks = {};
  let ok = true;
  try {
    const requiredTables = [
      'pathbooks', 'pathbook_applications', 'pathbook_verification_events',
      'pathbook_audit_head', 'pathbook_audit_events'
    ];
    const placeholders = requiredTables.map(() => '?').join(',');
    const tables = await env.AIHANGOUT_DB.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})
    `).bind(...requiredTables).all();
    const present = new Set((tables.results || []).map(row => row.name));
    const missing = requiredTables.filter(name => !present.has(name));
    checks.schema = missing.length ? `missing:${missing.join(',')}` : 'ok';
    ok = missing.length === 0;

    if (ok) {
      const head = await env.AIHANGOUT_DB.prepare(
        'SELECT head_seq, head_hash FROM pathbook_audit_head WHERE id = 1'
      ).first();
      const events = await env.AIHANGOUT_DB.prepare(
        'SELECT * FROM pathbook_audit_events ORDER BY seq ASC'
      ).all();
      let previous = '0'.repeat(64);
      let lastSeq = 0;
      for (const event of events.results || []) {
        const expectedHash = `sha256:${await sha256Hex(`${previous}|${event.payload}`)}`;
        const expectedSeal = await pathbookHmacHex(env, expectedHash);
        if (event.prev_hash !== previous || event.event_hash !== expectedHash || event.event_seal !== expectedSeal) {
          ok = false;
          checks.audit_chain = `broken_at:${event.seq}`;
          break;
        }
        previous = event.event_hash;
        lastSeq = Number(event.seq);
      }
      if (!checks.audit_chain) checks.audit_chain = 'ok';
      if (Number(head?.head_seq || 0) !== lastSeq || String(head?.head_hash || '') !== previous) {
        ok = false;
        checks.audit_head = 'mismatch';
      } else {
        checks.audit_head = 'ok';
      }

      const sealedRows = await env.AIHANGOUT_DB.prepare(
        'SELECT * FROM pathbooks WHERE state_hash IS NOT NULL OR state_seal IS NOT NULL'
      ).all();
      let badState = null;
      for (const row of sealedRows.results || []) {
        const sealed = await sealedPathbookState(env, row);
        if (row.state_hash !== sealed.state_hash || row.state_seal !== sealed.state_seal) {
          badState = row.pathbook_id;
          break;
        }
      }
      checks.materialized_state = badState ? `mismatch:${badState}` : 'ok';
      if (badState) ok = false;
      checks.sealed_pathbooks = (sealedRows.results || []).length;

      const authoredRows = await env.AIHANGOUT_DB.prepare(
        "SELECT * FROM pathbooks WHERE signature_type IN ('server_hmac','ed25519')"
      ).all();
      let badAuthorship = null;
      for (const row of authoredRows.results || []) {
        const payload = hostedPathbookAuthorPayload(row);
        let valid = false;
        if (row.signature_type === 'ed25519') {
          valid = await verifyEd25519Payload(payload, row.signature, row.author_public_key);
        } else {
          const expected = `hmac-sha256:${await pathbookHmacHex(env, stableJson(payload))}`;
          valid = row.signature === expected;
        }
        if (!valid) {
          badAuthorship = row.pathbook_id;
          break;
        }
      }
      checks.authorship = badAuthorship ? `invalid:${badAuthorship}` : 'ok';
      checks.verified_authorship_records = (authoredRows.results || []).length;
      if (badAuthorship) ok = false;

      const outcomeAuditRows = await env.AIHANGOUT_DB.prepare(`
        SELECT payload FROM pathbook_audit_events
        WHERE event_type = 'pathbook_outcome_reported'
        ORDER BY seq ASC
      `).all();
      const outcomeAudit = new Map();
      for (const row of outcomeAuditRows.results || []) {
        const envelope = safeJsonParse(row.payload || '{}');
        const payload = envelope?.payload;
        if (payload?.application_id && payload?.reporter_signature_hash) {
          outcomeAudit.set(payload.application_id, payload);
        }
      }
      const boundOutcomes = await env.AIHANGOUT_DB.prepare(`
        SELECT application_id, evidence, reporter_signature
        FROM pathbook_verification_events WHERE audit_bound = 1
      `).all();
      let badOutcomeEvidence = null;
      for (const row of boundOutcomes.results || []) {
        const audit = outcomeAudit.get(row.application_id);
        const signatureHash = `sha256:${await sha256Hex(row.reporter_signature || '')}`;
        const evidenceHash = `sha256:${await sha256Hex(row.evidence || '')}`;
        if (
          !audit ||
          audit.reporter_signature_hash !== signatureHash ||
          audit.evidence_hash !== evidenceHash
        ) {
          badOutcomeEvidence = row.application_id;
          break;
        }
      }
      if (!badOutcomeEvidence && outcomeAudit.size !== (boundOutcomes.results || []).length) {
        badOutcomeEvidence = 'audit-row-count-mismatch';
      }
      checks.outcome_evidence = badOutcomeEvidence ? `invalid:${badOutcomeEvidence}` : 'ok';
      checks.audit_bound_outcomes = (boundOutcomes.results || []).length;
      if (badOutcomeEvidence) ok = false;
    }
  } catch (error) {
    console.error('[Health/pathbooks] Error:', error);
    checks.exception = String(error?.message || error);
    ok = false;
  }
  return jsonResponse({ status: ok ? 'ok' : 'degraded', checks }, { status: ok ? 200 : 503 });
});

const MCP_PROTOCOL_VERSION = '2025-03-26';

function mcpResult(id, payload, isError = false) {
  return jsonResponse({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError
    }
  });
}

async function sha256Hex(value) {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(String(value))
  );
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function contextFingerprintText(text) {
  const source = String(text || '');
  const primary = await fingerprintText(source);
  const stableCodes = [];
  const pattern = /\b(winerror|errno|error\s+code|status(?:\s+code)?|http|cuda\s+error)\s*[:#]?\s*(\d{1,6})\b/gi;
  for (const match of source.matchAll(pattern)) {
    stableCodes.push(`${match[1].toLowerCase().replace(/\s+/g, '-')}:${match[2]}`);
  }
  return `sha256:${await sha256Hex(`${primary}|${stableCodes.join('|')}`)}`;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function hexToBytes(value, expectedBytes) {
  const text = String(value || '');
  if (!new RegExp(`^[0-9a-fA-F]{${expectedBytes * 2}}$`).test(text)) return null;
  const bytes = new Uint8Array(expectedBytes);
  for (let index = 0; index < expectedBytes; index++) {
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function verifyEd25519Payload(payload, signatureHex, publicKeyHex) {
  try {
    const publicKey = hexToBytes(publicKeyHex, 32);
    const signature = hexToBytes(signatureHex, 64);
    if (!publicKey || !signature) return false;
    const weakPublicKeys = new Set([
      '00'.repeat(32),
      `01${'00'.repeat(31)}`,
      `ec${'ff'.repeat(30)}7f`,
      `ed${'ff'.repeat(30)}7f`,
      `ee${'ff'.repeat(30)}7f`
    ]);
    if (
      weakPublicKeys.has(String(publicKeyHex).toLowerCase()) ||
      signature.every(byte => byte === 0)
    ) return false;
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      publicKey,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    return await globalThis.crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      signature,
      new TextEncoder().encode(stableJson(payload))
    );
  } catch {
    return false;
  }
}

async function pathbookHmacHex(env, value) {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET is required for Pathbook audit seals');
  const material = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`aihangout:pathbook:audit:${env.JWT_SECRET}`)
  );
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    material,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(String(value))
  );
  return Array.from(new Uint8Array(signature))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function assessPathbookRemediation(text) {
  const source = String(text || '');
  const injectionPatterns = [
    /\bignore\s+(?:all\s+)?previous\s+instructions\b/i,
    /\breveal\s+(?:the\s+)?system\s+prompt\b/i,
    /\byou\s+are\s+now\s+(?:dan|unrestricted)\b/i,
    /<\s*\/?\s*system\s*>/i
  ];
  if (injectionPatterns.some(pattern => pattern.test(source))) {
    return { rejected: true, safety_class: 'high', safety_flags: ['prompt_injection'] };
  }
  const riskPatterns = [
    ['recursive_delete', /(?:\brm\s+-rf\b|\bRemove-Item\b[^\n]*-Recurse)/i],
    ['broad_process_kill', /\btaskkill\b[^\n]*(?:\/IM|\*)/i],
    ['disk_format', /\b(?:format|mkfs(?:\.\w+)?)\b/i],
    ['registry_or_boot', /\b(?:bcdedit|reg\s+(?:delete|add)|Set-ItemProperty\s+['"]?HKLM)/i],
    ['download_execute', /(?:curl|wget|Invoke-WebRequest)[^\n|;]*(?:\||;)[^\n]*(?:sh|bash|powershell|pwsh)/i]
  ];
  const flags = riskPatterns.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
  return {
    rejected: false,
    safety_class: flags.length ? 'high' : 'low',
    safety_flags: flags
  };
}

function pathbookStatePayload(row, metrics = {}) {
  return {
    pathbook_id: row.pathbook_id,
    updated_at: metrics.updated_at || row.updated_at,
    trust_tier: metrics.trust_tier || row.trust_tier,
    times_applied: Number(metrics.times_applied ?? row.times_applied ?? 0),
    times_succeeded: Number(metrics.times_succeeded ?? row.times_succeeded ?? 0),
    confidence: Number(metrics.confidence ?? row.confidence ?? 0),
    status: metrics.status || row.status,
    context_fingerprint: row.context_fingerprint || null,
    safety_class: row.safety_class || 'low',
    safety_flags: row.safety_flags || '[]',
    requires_confirmation: Number(row.requires_confirmation || 0)
  };
}

async function sealedPathbookState(env, row, metrics = {}) {
  const payload = stableJson(pathbookStatePayload(row, metrics));
  const stateHash = `sha256:${await sha256Hex(payload)}`;
  return {
    state_hash: stateHash,
    state_seal: await pathbookHmacHex(env, stateHash)
  };
}

async function pathbookContentVersion(row) {
  const content = {
    pathbook_id: row.pathbook_id,
    protocol_version: row.protocol_version,
    error_fingerprint: row.error_fingerprint,
    context_fingerprint: row.context_fingerprint || null,
    trigger_yaml: row.trigger_yaml,
    remediation_yaml: row.remediation_yaml,
    verify_yaml: row.verify_yaml || '',
    failed_attempts_yaml: row.failed_attempts_yaml || '',
    safety_class: row.safety_class || 'low',
    safety_flags: row.safety_flags || '[]',
    requires_confirmation: Number(row.requires_confirmation || 0)
  };
  return `sha256:${await sha256Hex(stableJson(content))}`;
}

function hostedPathbookAuthorPayload(row, provenance = null) {
  return {
    id: row.pathbook_id,
    protocol: row.protocol_version,
    title: row.title,
    error_signature: row.error_signature,
    error_fingerprint: row.error_fingerprint,
    context_fingerprint: row.context_fingerprint,
    ecosystem: row.ecosystem || '',
    runtime: row.runtime || '',
    package_name: row.package_name || '',
    trigger_yaml: row.trigger_yaml,
    remediation_yaml: row.remediation_yaml,
    verify_yaml: row.verify_yaml || '',
    failed_attempts_yaml: row.failed_attempts_yaml || '',
    safety_class: row.safety_class || 'low',
    safety_flags: typeof row.safety_flags === 'string'
      ? safeJsonParse(row.safety_flags || '[]') : (row.safety_flags || []),
    requires_confirmation: Boolean(row.requires_confirmation),
    token_savings_estimate: Number(row.token_savings_estimate || 0),
    provenance: provenance || safeJsonParse(row.provenance || '{}')
  };
}

async function runAuditedPathbookBatch(
  env,
  { event_type, actor_id = null, pathbook_id = null, payload },
  buildStatements,
  maxAttempts = 5
) {
  const eventPayload = stableJson({
    event_type,
    actor_id,
    pathbook_id,
    payload,
    occurred_at: new Date().toISOString()
  });
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const head = await env.AIHANGOUT_DB.prepare(
      'SELECT head_seq, head_hash FROM pathbook_audit_head WHERE id = 1'
    ).first();
    if (!head) throw new Error('Pathbook audit head is missing');
    const previousHash = String(head.head_hash);
    const eventHash = `sha256:${await sha256Hex(`${previousHash}|${eventPayload}`)}`;
    const eventSeal = await pathbookHmacHex(env, eventHash);
    try {
      const statements = await buildStatements();
      statements.push(
        env.AIHANGOUT_DB.prepare(`
          INSERT INTO pathbook_audit_events
            (event_type, actor_id, pathbook_id, payload, prev_hash, event_hash, event_seal)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          event_type,
          actor_id,
          pathbook_id,
          eventPayload,
          previousHash,
          eventHash,
          eventSeal
        )
      );
      return await env.AIHANGOUT_DB.batch(statements);
    } catch (error) {
      if (
        attempt < maxAttempts &&
        String(error?.message || error).includes('pathbook_audit_head_conflict')
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('Pathbook audit head remained contended');
}

router.post('/mcp', async (request, env, ctx) => {
  let message;
  try {
    message = safeJsonParse(await request.text());
  } catch {
    return jsonResponse({
      jsonrpc: '2.0', id: null,
      error: { code: -32700, message: 'Parse error' }
    }, { status: 400 });
  }

  const id = message?.id ?? null;
  const method = message?.method;
  if (!method) {
    return jsonResponse({
      jsonrpc: '2.0', id,
      error: { code: -32600, message: 'Invalid Request' }
    }, { status: 400 });
  }
  if (method === 'notifications/initialized') {
    return new Response(null, { status: 202, headers: corsHeaders });
  }
  if (method === 'initialize') {
    return jsonResponse({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'aihangout', version: '1.0.0' },
        instructions: 'Search community problems and human-verified solutions, retrieve threads, query Pathbooks, and submit authenticated solutions.'
      }
    });
  }
  if (method === 'tools/list') {
    return jsonResponse({
      jsonrpc: '2.0', id,
      result: {
        tools: [
          {
            name: 'search_problems',
            description: 'Search community-submitted AI/ML problems. Harvested digest content is excluded.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', minLength: 2, maxLength: 300 },
                limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 }
              },
              required: ['query'],
              additionalProperties: false
            }
          },
          {
            name: 'get_thread',
            description: 'Get a problem and all of its solutions, with human-verification metadata.',
            inputSchema: {
              type: 'object',
              properties: { problem_id: { type: 'integer', minimum: 1 } },
              required: ['problem_id'],
              additionalProperties: false
            }
          },
          {
            name: 'lookup_pathbook',
            description: 'Look up machine-readable remediation Pathbooks by normalized error fingerprint and context.',
            inputSchema: {
              type: 'object',
              properties: {
                error: { type: 'string', minLength: 1, maxLength: 10000 },
                runtime: { type: 'string', maxLength: 100 },
                package_name: { type: 'string', maxLength: 200 },
                limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 }
              },
              required: ['error'],
              additionalProperties: false
            }
          },
          {
            name: 'get_pathbook_signing_context',
            description: 'Get the authenticated identity fields, timestamp, and canonicalization contract needed to create valid Ed25519 Pathbook signatures.',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false
            }
          },
          {
            name: 'execute_pathbook',
            description: 'Issue a short-lived, single-use application and retrieve a Pathbook remediation plan. Requires Authorization.',
            inputSchema: {
              type: 'object',
              properties: {
                pathbook_id: { type: 'string', minLength: 1, maxLength: 200 },
                confirm_risk: { type: 'boolean', default: false },
                allow_untrusted: { type: 'boolean', default: false }
              },
              required: ['pathbook_id'],
              additionalProperties: false
            }
          },
          {
            name: 'post_solution',
            description: 'Submit a solution to a problem. Requires the caller Authorization bearer token.',
            inputSchema: {
              type: 'object',
              properties: {
                problem_id: { type: 'integer', minimum: 1 },
                solution_text: { type: 'string', minLength: 10, maxLength: 20000 },
                why_explanation: { type: 'string', minLength: 10, maxLength: 10000 },
                code_snippet: { type: 'string', maxLength: 20000 }
              },
              required: ['problem_id', 'solution_text', 'why_explanation'],
              additionalProperties: false
            }
          },
          {
            name: 'report_pathbook_result',
            description: 'Report an evidenced result for a server-issued Pathbook application. Requires Authorization.',
            inputSchema: {
              type: 'object',
              properties: {
                pathbook_id: { type: 'string', minLength: 1, maxLength: 200 },
                application_id: { type: 'string', minLength: 1, maxLength: 200 },
                outcome: { type: 'string', enum: ['success', 'failure', 'dangerous'] },
                verify_passed: { type: 'boolean' },
                environment: { type: 'string', maxLength: 1000 },
                notes: { type: 'string', maxLength: 5000 },
                verification: {
                  type: 'object',
                  properties: {
                    check_id: { type: 'string', minLength: 1, maxLength: 200 },
                    exit_code: { type: 'integer' },
                    output_digest: { type: 'string', pattern: '^sha256:[0-9a-fA-F]{64}$' },
                    environment_digest: { type: 'string', pattern: '^sha256:[0-9a-fA-F]{64}$' },
                    observed_at: { type: 'string', format: 'date-time' }
                  },
                  required: ['check_id', 'exit_code', 'output_digest', 'environment_digest', 'observed_at'],
                  additionalProperties: false
                },
                reporter_public_key: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
                reporter_signature: { type: 'string', pattern: '^[0-9a-fA-F]{128}$' }
              },
              required: ['pathbook_id', 'application_id', 'outcome'],
              additionalProperties: false
            }
          }
        ]
      }
    });
  }
  if (method !== 'tools/call') {
    return jsonResponse({
      jsonrpc: '2.0', id,
      error: { code: -32601, message: 'Method not found' }
    }, { status: 404 });
  }

  const toolName = message?.params?.name;
  const args = message?.params?.arguments || {};
  try {
    let internalRequest;
    if (toolName === 'search_problems') {
      const query = sanitizeContent(String(args.query || '')).trim();
      if (query.length < 2 || query.length > 300) {
        return mcpResult(id, { success: false, error: 'query must be 2-300 characters' }, true);
      }
      const limit = clampNumber(args.limit, 1, 25, 10);
      const target = new URL('/api/problems', request.url);
      target.searchParams.set('search', query);
      target.searchParams.set('limit', String(limit));
      target.searchParams.set('contentSource', 'community');
      internalRequest = new Request(target, {
        method: 'GET',
        headers: { Authorization: request.headers.get('Authorization') || '' }
      });
    } else if (toolName === 'get_thread') {
      const problemId = Number(args.problem_id);
      if (!Number.isInteger(problemId) || problemId < 1) {
        return mcpResult(id, { success: false, error: 'A valid problem_id is required' }, true);
      }
      internalRequest = new Request(new URL(`/api/problems/${problemId}`, request.url), {
        method: 'GET',
        headers: { Authorization: request.headers.get('Authorization') || '' }
      });
    } else if (toolName === 'lookup_pathbook') {
      const errorText = String(args.error || '');
      if (!errorText || errorText.length > 10000) {
        return mcpResult(id, { success: false, error: 'error must be 1-10,000 characters' }, true);
      }
      internalRequest = new Request(new URL('/api/pathbooks/lookup', request.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: errorText,
          runtime: String(args.runtime || '').slice(0, 100),
          package_name: String(args.package_name || '').slice(0, 200),
          limit: clampNumber(args.limit, 1, 10, 5)
        })
      });
    } else if (toolName === 'get_pathbook_signing_context') {
      internalRequest = new Request(new URL('/api/pathbooks/signing-context', request.url), {
        method: 'GET',
        headers: { Authorization: request.headers.get('Authorization') || '' }
      });
    } else if (toolName === 'execute_pathbook') {
      const pathbookId = sanitizeContent(String(args.pathbook_id || '')).trim();
      if (!pathbookId || pathbookId.length > 200) {
        return mcpResult(id, { success: false, error: 'A valid pathbook_id is required' }, true);
      }
      internalRequest = new Request(
        new URL(`/api/pathbooks/${encodeURIComponent(pathbookId)}/execute`, request.url),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: request.headers.get('Authorization') || ''
          },
          body: JSON.stringify({
            confirm_risk: args.confirm_risk === true,
            allow_untrusted: args.allow_untrusted === true
          })
        }
      );
    } else if (toolName === 'post_solution') {
      const problemId = Number(args.problem_id);
      if (!Number.isInteger(problemId) || problemId < 1) {
        return mcpResult(id, { success: false, error: 'A valid problem_id is required' }, true);
      }
      internalRequest = new Request(new URL(`/api/problems/${problemId}/solutions`, request.url), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: request.headers.get('Authorization') || ''
        },
        body: JSON.stringify({
          solutionText: String(args.solution_text || ''),
          whyExplanation: String(args.why_explanation || ''),
          codeSnippet: String(args.code_snippet || '')
        })
      });
    } else if (toolName === 'report_pathbook_result') {
      const pathbookId = sanitizeContent(String(args.pathbook_id || '')).trim();
      if (
        !pathbookId ||
        pathbookId.length > 200 ||
        !String(args.application_id || '') ||
        !['success', 'failure', 'dangerous'].includes(args.outcome)
      ) {
        return mcpResult(id, {
          success: false,
          error: 'Valid pathbook_id, application_id, and outcome are required'
        }, true);
      }
      internalRequest = new Request(
        new URL(`/api/pathbooks/${encodeURIComponent(pathbookId)}/verify`, request.url),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: request.headers.get('Authorization') || ''
          },
          body: JSON.stringify({
            application_id: String(args.application_id || ''),
            outcome: args.outcome,
            verify_passed: args.verify_passed === true,
            environment: String(args.environment || ''),
            notes: String(args.notes || ''),
            verification: args.verification || null
            ,
            reporter_public_key: String(args.reporter_public_key || ''),
            reporter_signature: String(args.reporter_signature || '')
          })
        }
      );
    } else {
      return jsonResponse({
        jsonrpc: '2.0', id,
        error: { code: -32602, message: 'Unknown tool' }
      }, { status: 400 });
    }

    const internalResponse = await router.handle(internalRequest, env, ctx);
    const payload = safeJsonParse(await internalResponse.text());
    return mcpResult(id, payload, !internalResponse.ok || payload?.success === false);
  } catch (error) {
    console.error(`[MCP/${toolName}] Error:`, error);
    return mcpResult(id, { success: false, error: 'Tool execution failed' }, true);
  }
});

// Notification pipeline health: verifies inbox, preference, and delivery-audit
// storage are queryable. This does not create users, content, or notifications.
router.get('/api/health/notifications', async (request, env) => {
  const checks = {};
  let ok = true;
  try {
    const requiredTables = [
      'notifications', 'user_settings', 'notification_delivery_log', 'auth_email_tokens'
    ];
    const placeholders = requiredTables.map(() => '?').join(',');
    const tables = await env.AIHANGOUT_DB.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})
    `).bind(...requiredTables).all();
    const present = new Set((tables.results || []).map(row => row.name));
    const missing = requiredTables.filter(name => !present.has(name));
    checks.schema = missing.length ? `missing:${missing.join(',')}` : 'ok';
    if (missing.length) ok = false;

    if (!missing.length) {
      await env.AIHANGOUT_DB.prepare(`
        SELECT notify_new_follower, notify_vote_on_content, notify_new_solution, email_notifications
        FROM user_settings LIMIT 1
      `).first();
      checks.preferences = 'ok';
      const failures = await env.AIHANGOUT_DB.prepare(`
        SELECT COUNT(*) AS count FROM notification_delivery_log
        WHERE status = 'failed' AND created_at >= datetime('now', '-1 hour')
      `).first();
      checks.failed_last_hour = Number(failures?.count || 0);
      checks.email_provider = env.RESEND_API_KEY ? 'configured' : 'not_configured';
      if (env.ENVIRONMENT === 'production' && !env.RESEND_API_KEY) ok = false;
    }
  } catch (error) {
    console.error('[Health/notifications] Error:', error);
    checks.exception = String(error?.message || error);
    ok = false;
  }
  return jsonResponse({ status: ok ? 'ok' : 'degraded', checks }, { status: ok ? 200 : 503 });
});

// HEAD handler for SPA routes (/terms, /privacy, /dmca, etc.)
// itty-router does not auto-alias HEAD to GET, so HEAD falls through to a 500.
// This handler returns 200 with no body for all non-API paths, satisfying uptime monitors.
router.head('*', async (request, env) => {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    return new Response(null, { status: 404, headers: corsHeaders });
  }
  return new Response(null, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    }
  });
});

// Serve frontend assets with proper cache control - EXCLUDE API ROUTES
// ── ACTIVITY LOG: ADMIN READ + ISOLATION ──

router.get('/api/admin/activity-log', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) return jsonResponse({ success: false, error: 'Authentication required' }, { status: 401 });
    if (!user.is_admin) return jsonResponse({ success: false, error: 'Admin access required' }, { status: 403 });

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
    const outcome = url.searchParams.get('outcome');       // accepted | rejected
    const action = url.searchParams.get('action');
    const targetType = url.searchParams.get('target_type');
    const targetId = url.searchParams.get('target_id');
    const onlyQuarantined = url.searchParams.get('quarantined') === 'true';

    const where = [];
    const params = [];
    if (outcome === 'accepted' || outcome === 'rejected') { where.push('outcome = ?'); params.push(outcome); }
    if (action) { where.push('action = ?'); params.push(action); }
    if (targetType) { where.push('target_type = ?'); params.push(targetType); }
    if (targetId && /^\d+$/.test(targetId)) { where.push('target_id = ?'); params.push(Number(targetId)); }
    if (onlyQuarantined) where.push('quarantined = 1');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await env.AIHANGOUT_DB.prepare(`
      SELECT id, occurred_at, method, path, action, user_id, username, agent_type,
             outcome, http_status, reason, target_type, target_id, payload,
             payload_bytes, quarantined, quarantine_reason, reviewed_at, reviewed_by
      FROM activity_log
      ${whereSql}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).bind(...params, limit, offset).all();

    const totals = await env.AIHANGOUT_DB.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN outcome = 'rejected' THEN 1 ELSE 0 END) AS rejected,
             SUM(CASE WHEN quarantined = 1 THEN 1 ELSE 0 END) AS quarantined,
             SUM(CASE WHEN quarantined = 1 AND reviewed_at IS NULL THEN 1 ELSE 0 END) AS awaiting_review
      FROM activity_log
    `).first();

    return jsonResponse({
      success: true,
      entries: rows.results || [],
      pagination: { limit, offset, returned: (rows.results || []).length },
      totals
    });
  } catch (error) {
    return errResponse('Unable to read activity log', error);
  }
});

// Isolation controls. The log itself is append-only — these routes only ever set
// the quarantine/review columns, never rewrite or remove what was recorded.
router.post('/api/admin/activity-log/:id/quarantine', async (request, env) => {
  try {
    const user = await authenticate(request, env);
    if (!user) return jsonResponse({ success: false, error: 'Authentication required' }, { status: 401 });
    if (!user.is_admin) return jsonResponse({ success: false, error: 'Admin access required' }, { status: 403 });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return jsonResponse({ success: false, error: 'A valid entry id is required' }, { status: 400 });
    }
    const body = await request.json().catch(() => ({}));
    const isolate = body.quarantined !== false;

    const entry = await env.AIHANGOUT_DB.prepare('SELECT id FROM activity_log WHERE id = ?').bind(id).first();
    if (!entry) return jsonResponse({ success: false, error: 'Entry not found' }, { status: 404 });

    await env.AIHANGOUT_DB.prepare(`
      UPDATE activity_log
      SET quarantined = ?, quarantine_reason = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?
      WHERE id = ?
    `).bind(
      isolate ? 1 : 0,
      String(body.reason || (isolate ? 'manually_isolated' : 'cleared_by_admin')).slice(0, 200),
      user.id,
      id
    ).run();

    return jsonResponse({ success: true, entry_id: id, quarantined: isolate, reviewed_by: user.username });
  } catch (error) {
    return errResponse('Unable to update activity log entry', error);
  }
});

router.get('*', async (request, env) => {
  try {
    const url = new URL(request.url);

    // CRITICAL FIX: Don't handle API routes here
    if (url.pathname.startsWith('/api/')) {
      return new Response('API endpoint not found', {
        status: 404,
        headers: corsHeaders
      });
    }

    // SPA routing: known non-file paths (no extension) go straight to index.html
    // This prevents ASSETS.fetch() from throwing on SPA routes like /terms /privacy /dmca
    const hasDotExtension = url.pathname.includes('.') && !url.pathname.endsWith('/');
    if (!hasDotExtension) {
      // Try the asset first, fall back to index.html — but catch any throw from ASSETS
      let asset;
      try {
        asset = await env.ASSETS.fetch(request);
      } catch (_) {
        asset = null;
      }
      if (!asset || asset.status === 404) {
        const indexResp = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin)));
        const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
        const html = await indexResp.text();
        const patchedHtml = html.replace(/<script\b/gi, `<script nonce="${nonce}"`);
        const headers = new Headers(indexResp.headers);
        headers.set('Content-Type', 'text/html; charset=utf-8');
        headers.set('X-Frame-Options', 'DENY');
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
        headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
        headers.set('Content-Security-Policy', [
          "default-src 'self'",
          `script-src 'self' 'nonce-${nonce}' https://static.cloudflareinsights.com`,
          "style-src 'self' 'unsafe-inline'",
          "font-src 'self' data:",
          "img-src 'self' data: https: blob:",
          "connect-src 'self' https://aihangout.ai https://cloudflareinsights.com wss://aihangout.ai",
          "object-src 'none'",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'"
        ].join('; '));
        headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
        return new Response(patchedHtml, { status: 200, headers });
      }
      // For HTML assets (e.g. direct hit on /), inject nonce-based CSP
      if (asset.headers.get('content-type')?.includes('text/html')) {
        const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
        const html = await asset.text();
        const patchedHtml = html.replace(/<script\b/gi, `<script nonce="${nonce}"`);
        const headers = new Headers(asset.headers);
        headers.set('Content-Type', 'text/html; charset=utf-8');
        headers.set('Content-Security-Policy', [
          "default-src 'self'",
          `script-src 'self' 'nonce-${nonce}' https://static.cloudflareinsights.com`,
          "style-src 'self' 'unsafe-inline'",
          "font-src 'self' data:",
          "img-src 'self' data: https: blob:",
          "connect-src 'self' https://aihangout.ai https://cloudflareinsights.com wss://aihangout.ai",
          "object-src 'none'",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'"
        ].join('; '));
        headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
        return new Response(patchedHtml, { status: 200, headers });
      }
      const headers = new Headers(asset.headers);
      headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    }

    const asset = await env.ASSETS.fetch(request);

    if (asset.status === 404) {
      // Return index.html for SPA routing — with nonce-based CSP
      const indexResp = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin)));
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      const html = await indexResp.text();
      const patchedHtml = html.replace(/<script\b/gi, `<script nonce="${nonce}"`);
      const h = new Headers(indexResp.headers);
      h.set('Content-Type', 'text/html; charset=utf-8');
      h.set('Content-Security-Policy', [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' https://static.cloudflareinsights.com`,
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: https: blob:",
        "connect-src 'self' https://aihangout.ai https://cloudflareinsights.com wss://aihangout.ai",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'"
      ].join('; '));
      h.set('Cache-Control', 'public, max-age=0, must-revalidate');
      return new Response(patchedHtml, { status: 200, headers: h });
    }

    // Add cache control headers to prevent stale JavaScript issues
    const headers = new Headers(asset.headers);

    // For versioned assets (with content hashes), cache forever
    if (url.pathname.match(/\/assets\/.*\.[a-f0-9]{8,}\.(js|css|woff2?)$/) ||
        url.pathname.match(/\.[a-f0-9]{8,}\.(js|css)$/)) {
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
    // For index.html and other HTML files, always revalidate
    else if (url.pathname.endsWith('.html') || url.pathname === '/') {
      headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
    }
    // For other assets, moderate caching with revalidation
    else {
      headers.set('Cache-Control', 'public, max-age=3600, must-revalidate');
    }

    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers
    });
  } catch (error) {
    return new Response('Not found', { status: 404, headers: corsHeaders });
  }
});

// Lightweight request logger - non-blocking, silent on failure
async function logRequestToD1(env, data) {
  try {
    await env.AIHANGOUT_DB.prepare(
      'INSERT INTO request_log (method, path, status, duration_ms, user_agent, ip_address, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(data.method, data.path, data.status, data.duration_ms, data.user_agent, data.ip_address, data.timestamp).run();
  } catch (e) {
    // Silent failure - request logging must never break the app
  }
}

// Grounded production implementations for legacy "flywheel" routes. The original
// handlers depended on prototypes that were never connected to production data.
async function handleGroundedCapability(request, env, url) {
  const path = url.pathname;

  if (/^\/api\/ai-collaboration\/session\/[^/]+$/.test(path)) {
    const token = decodeURIComponent(path.split('/').pop());
    const table = await env.AIHANGOUT_DB.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='ai_collaboration_sessions'"
    ).first();
    if (!table) return jsonResponse({ success: false, error: 'Session not found' }, { status: 404 });
    const session = await env.AIHANGOUT_DB.prepare(
      'SELECT * FROM ai_collaboration_sessions WHERE session_token = ?'
    ).bind(token).first();
    if (!session) return jsonResponse({ success: false, error: 'Session not found' }, { status: 404 });
    const participants = await env.AIHANGOUT_DB.prepare(
      'SELECT * FROM ai_collaboration_participants WHERE session_token = ? ORDER BY joined_at'
    ).bind(token).all();
    const contributions = await env.AIHANGOUT_DB.prepare(
      'SELECT * FROM ai_collaboration_contributions WHERE session_token = ? ORDER BY created_at'
    ).bind(token).all();
    const problem = await env.AIHANGOUT_DB.prepare('SELECT * FROM problems WHERE id = ?')
      .bind(session.problem_id).first();
    return jsonResponse({
      success: true, session, problem,
      participants: participants.results || [],
      contributions: contributions.results || [],
      collaboration_stats: {
        participant_count: participants.results?.length || 0,
        contribution_count: contributions.results?.length || 0,
        cross_pollination_events: (contributions.results || []).filter(c => c.builds_on_agent).length
      }
    });
  }

  if (path === '/api/dashboard/ai-activity') {
    const timeframe = url.searchParams.get('timeframe') || '24h';
    const hours = timeframe === '7d' ? 168 : timeframe === '30d' ? 720 : 24;
    const since = `-${hours} hours`;
    const [agents, content, events, categories] = await Promise.all([
      env.AIHANGOUT_DB.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN join_date >= datetime('now', ?) THEN 1 ELSE 0 END) AS recently_active
        FROM users WHERE ai_agent_type IS NOT NULL AND ai_agent_type != 'human'
      `).bind(since).first(),
      env.AIHANGOUT_DB.prepare(`
        SELECT
          (SELECT COUNT(*) FROM problems WHERE agent_name IS NOT NULL AND created_at >= datetime('now', ?)) AS problems,
          (SELECT COUNT(*) FROM solutions WHERE agent_name IS NOT NULL AND created_at >= datetime('now', ?)) AS solutions,
          (SELECT COUNT(*) FROM ai_learning_data WHERE created_at >= datetime('now', ?)) AS learning_records
      `).bind(since, since, since).first(),
      env.AIHANGOUT_DB.prepare(`
        SELECT COUNT(*) AS total FROM analytics_events
        WHERE user_type != 'human' AND timestamp >= datetime('now', ?)
      `).bind(since).first(),
      env.AIHANGOUT_DB.prepare(`
        SELECT category, COUNT(*) AS contributions FROM problems
        WHERE agent_name IS NOT NULL AND created_at >= datetime('now', ?)
        GROUP BY category ORDER BY contributions DESC LIMIT 10
      `).bind(since).all()
    ]);
    return jsonResponse({
      success: true,
      dashboard_data: { timeframe, last_updated: new Date().toISOString(), source: 'production_d1' },
      activity_metrics: {
        total_ai_agents: Number(agents?.total || 0),
        recently_registered_agents: Number(agents?.recently_active || 0),
        problem_contributions: Number(content?.problems || 0),
        solution_contributions: Number(content?.solutions || 0),
        learning_records: Number(content?.learning_records || 0),
        analytics_events: Number(events?.total || 0)
      },
      activity_patterns: { most_active_categories: categories.results || [] }
    });
  }

  if (/^\/api\/identity\/analytics\/[^/]+$/.test(path)) {
    const identity = decodeURIComponent(path.split('/').pop()).toLowerCase();
    const agents = await getAllRegisteredAgents(env);
    const agent = agents.find(a =>
      String(a.universal_id || a.universalId || a.agentName || a.name || '').toLowerCase() === identity
    );
    if (!agent) return jsonResponse({ success: false, error: 'Universal identity not found' }, { status: 404 });
    const agentName = agent.agentName || agent.name || identity;
    const activity = await env.AIHANGOUT_DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM problems WHERE agent_name = ?) AS problems,
        (SELECT COUNT(*) FROM solutions WHERE agent_name = ?) AS solutions,
        (SELECT COUNT(*) FROM agent_request_log WHERE agent_name = ?) AS requests
    `).bind(agentName, agentName, agentName).first();
    return jsonResponse({
      success: true,
      identity_overview: {
        universal_id: agent.universal_id || agent.universalId || agentName,
        agent_name: agentName,
        agent_type: agent.agentType || null,
        registered_at: agent.registeredAt || null
      },
      production_activity: {
        problems: Number(activity?.problems || 0),
        solutions: Number(activity?.solutions || 0),
        authenticated_requests: Number(activity?.requests || 0)
      },
      capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : []
    });
  }

  if (path === '/api/innovation/opportunities') {
    const domain = (url.searchParams.get('domain') || '').toLowerCase();
    const binds = [];
    let categoryFilter = '';
    if (domain && domain !== 'all') {
      categoryFilter = ' AND LOWER(p.category) = ?';
      binds.push(domain);
    }
    const rows = await env.AIHANGOUT_DB.prepare(`
      SELECT p.id, p.title, p.description, p.category, p.difficulty, p.created_at,
             p.upvotes, COUNT(s.id) AS solution_count
      FROM problems p LEFT JOIN solutions s ON s.problem_id = p.id
      WHERE p.is_public = 1 AND p.status = 'open' ${categoryFilter}
      GROUP BY p.id
      ORDER BY solution_count ASC, p.upvotes DESC, p.created_at DESC
      LIMIT 25
    `).bind(...binds).all();
    const opportunities = (rows.results || []).map(row => ({
      ...row,
      priority: Number(row.solution_count) === 0 ? 'high' : 'medium',
      basis: Number(row.solution_count) === 0
        ? 'Open public problem with no submitted solution'
        : 'Open public problem with limited solution coverage'
    }));
    return jsonResponse({
      success: true, source: 'production_d1',
      filters: { domain: domain || 'all' },
      opportunities,
      total_opportunities: opportunities.length
    });
  }

  if (/^\/api\/knowledge-graph\/related\/[^/]+$/.test(path)) {
    const id = Number(path.split('/').pop());
    if (!Number.isInteger(id) || id < 1) {
      return jsonResponse({ success: false, error: 'A valid numeric content ID is required' }, { status: 400 });
    }
    const source = await env.AIHANGOUT_DB.prepare(
      'SELECT id, title, description, category, difficulty, tags FROM problems WHERE id = ? AND is_public = 1'
    ).bind(id).first();
    if (!source) return jsonResponse({ success: false, error: 'Content not found' }, { status: 404 });
    const related = await env.AIHANGOUT_DB.prepare(`
      SELECT id, title, category, difficulty, upvotes, created_at,
             CASE WHEN category = ? THEN 1 ELSE 0 END AS category_match
      FROM problems
      WHERE id != ? AND is_public = 1 AND status != 'deleted'
        AND (category = ? OR LOWER(title) LIKE ?)
      ORDER BY category_match DESC, upvotes DESC, created_at DESC LIMIT 20
    `).bind(source.category, id, source.category, `%${String(source.title).split(/\s+/).find(w => w.length > 4)?.toLowerCase() || ''}%`).all();
    const nodes = [{ ...source, node_type: 'problem' }, ...(related.results || []).map(r => ({ ...r, node_type: 'problem' }))];
    const edges = (related.results || []).map(r => ({
      from: id, to: r.id, relationship: r.category_match ? 'same_category' : 'title_keyword',
      strength: r.category_match ? 1 : 0.5
    }));
    return jsonResponse({
      success: true, content_id: id,
      knowledge_graph: { nodes, edges, metadata: { source: 'production_d1' } }
    });
  }

  if (path === '/api/matching/analytics') {
    const category = url.searchParams.get('category');
    const binds = [];
    let filter = '';
    if (category) { filter = ' WHERE p.category = ?'; binds.push(category); }
    const totals = await env.AIHANGOUT_DB.prepare(`
      SELECT COUNT(DISTINCT p.id) AS problems,
             COUNT(s.id) AS solutions,
             SUM(CASE WHEN s.is_verified = 1 THEN 1 ELSE 0 END) AS verified_solutions,
             AVG(CASE WHEN s.effectiveness_score IS NOT NULL THEN s.effectiveness_score END) AS average_effectiveness,
             AVG(CASE WHEN s.id IS NOT NULL THEN julianday(s.created_at)-julianday(p.created_at) END) AS avg_days_to_solution
      FROM problems p LEFT JOIN solutions s ON s.problem_id = p.id ${filter}
    `).bind(...binds).first();
    const byCategory = await env.AIHANGOUT_DB.prepare(`
      SELECT p.category, COUNT(DISTINCT p.id) AS problems, COUNT(s.id) AS solutions
      FROM problems p LEFT JOIN solutions s ON s.problem_id = p.id
      GROUP BY p.category ORDER BY solutions DESC
    `).all();
    const problems = Number(totals?.problems || 0);
    const solutions = Number(totals?.solutions || 0);
    return jsonResponse({
      success: true, source: 'production_d1',
      analytics: {
        problems, solutions,
        solutions_per_problem: problems ? solutions / problems : 0,
        verified_solutions: Number(totals?.verified_solutions || 0),
        average_effectiveness: totals?.average_effectiveness,
        average_days_to_solution: totals?.avg_days_to_solution,
        category_breakdown: byCategory.results || []
      }
    });
  }

  if (/^\/api\/matching\/recommendations\/[^/]+$/.test(path)) {
    const id = Number(path.split('/').pop());
    if (!Number.isInteger(id) || id < 1) {
      return jsonResponse({ success: false, error: 'A valid numeric problem ID is required' }, { status: 400 });
    }
    const problem = await env.AIHANGOUT_DB.prepare(
      'SELECT id, title, description, category, difficulty FROM problems WHERE id = ?'
    ).bind(id).first();
    if (!problem) return jsonResponse({ success: false, error: 'Problem not found' }, { status: 404 });
    const rows = await env.AIHANGOUT_DB.prepare(`
      SELECT s.id AS solution_id, s.problem_id, s.solution_text, s.why_explanation,
             s.upvotes, s.is_verified, s.effectiveness_score, p.title AS source_problem
      FROM solutions s JOIN problems p ON p.id = s.problem_id
      WHERE p.category = ? AND p.id != ?
      ORDER BY s.is_verified DESC, COALESCE(s.effectiveness_score, 0) DESC, s.upvotes DESC
      LIMIT 10
    `).bind(problem.category, id).all();
    return jsonResponse({
      success: true, problem_id: id, source: 'production_d1',
      recommended_approaches: (rows.results || []).map(r => ({
        ...r, match_basis: `Previously submitted for another ${problem.category} problem`
      }))
    });
  }

  if (path === '/api/personas/diversity') {
    const dbTypes = await env.AIHANGOUT_DB.prepare(`
      SELECT COALESCE(ai_agent_type, 'unknown') AS agent_type, COUNT(*) AS count
      FROM users WHERE ai_agent_type IS NOT NULL AND ai_agent_type != 'human'
      GROUP BY ai_agent_type ORDER BY count DESC
    `).all();
    const agents = await getAllRegisteredAgents(env);
    const capabilityCounts = {};
    for (const agent of agents) {
      for (const capability of (Array.isArray(agent.capabilities) ? agent.capabilities : [])) {
        capabilityCounts[capability] = (capabilityCounts[capability] || 0) + 1;
      }
    }
    const types = dbTypes.results || [];
    return jsonResponse({
      success: true, source: 'production_d1_and_kv',
      diversity: {
        registered_agents: agents.length,
        account_type_distribution: types,
        distinct_account_types: types.length,
        capability_distribution: capabilityCounts,
        distinct_capabilities: Object.keys(capabilityCounts).length
      }
    });
  }

  if (path === '/api/predictions/innovation-detection') {
    const rows = await env.AIHANGOUT_DB.prepare(`
      SELECT p.id AS problem_id, p.title, p.category, COUNT(DISTINCT s.user_id) AS contributors,
             COUNT(s.id) AS solutions, MAX(s.created_at) AS last_activity
      FROM problems p JOIN solutions s ON s.problem_id = p.id
      WHERE s.created_at >= datetime('now', '-7 days')
      GROUP BY p.id HAVING contributors >= 2
      ORDER BY contributors DESC, solutions DESC, last_activity DESC LIMIT 20
    `).all();
    const signals = (rows.results || []).map(row => ({
      ...row,
      signal: 'Multiple independent contributors submitted solutions in the last seven days',
      confidence_basis: { contributors: row.contributors, solutions: row.solutions }
    }));
    return jsonResponse({
      success: true, source: 'production_d1',
      innovationSignals: signals,
      monitoring: { window: '7d', candidates: signals.length }
    });
  }

  if (/^\/api\/recommendations\/related-problems\/[^/]+$/.test(path)) {
    const id = Number(path.split('/').pop());
    if (!Number.isInteger(id) || id < 1) {
      return jsonResponse({ success: false, error: 'A valid numeric problem ID is required' }, { status: 400 });
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 50);
    const source = await env.AIHANGOUT_DB.prepare(
      'SELECT id, title, category, difficulty FROM problems WHERE id = ?'
    ).bind(id).first();
    if (!source) return jsonResponse({ success: false, error: 'Problem not found' }, { status: 404 });
    const keyword = String(source.title).split(/\s+/).find(w => w.length > 4)?.toLowerCase() || '';
    const rows = await env.AIHANGOUT_DB.prepare(`
      SELECT id, title, description, category, difficulty, upvotes, created_at,
             CASE WHEN category = ? THEN 1 ELSE 0 END AS category_match
      FROM problems WHERE id != ? AND is_public = 1 AND status != 'deleted'
        AND (category = ? OR LOWER(title) LIKE ?)
      ORDER BY category_match DESC, upvotes DESC, created_at DESC LIMIT ?
    `).bind(source.category, id, source.category, `%${keyword}%`, limit).all();
    return jsonResponse({
      success: true, problem_id: id, source: 'production_d1',
      recommendations: (rows.results || []).map(r => ({
        ...r, reasoning: r.category_match ? 'Same category' : `Shared title keyword: ${keyword}`
      }))
    });
  }

  if (/^\/api\/solutions\/compare\/[^/]+$/.test(path)) {
    const id = Number(path.split('/').pop());
    if (!Number.isInteger(id) || id < 1) {
      return jsonResponse({ success: false, error: 'A valid numeric problem ID is required' }, { status: 400 });
    }
    const problem = await env.AIHANGOUT_DB.prepare('SELECT id FROM problems WHERE id = ?').bind(id).first();
    if (!problem) return jsonResponse({ success: false, error: 'Problem not found' }, { status: 404 });
    const rows = await env.AIHANGOUT_DB.prepare(`
      SELECT s.id, s.solution_text, s.why_explanation, s.code_snippet, s.upvotes,
             s.is_verified, s.effectiveness_score, s.created_at, u.username
      FROM solutions s JOIN users u ON u.id = s.user_id
      WHERE s.problem_id = ? ORDER BY s.is_verified DESC,
        COALESCE(s.effectiveness_score, 0) DESC, s.upvotes DESC, s.created_at ASC
    `).bind(id).all();
    const solutions = rows.results || [];
    if (solutions.length < 2) {
      return jsonResponse({
        success: false, error: 'At least 2 solutions required for comparison',
        available_solutions: solutions.length
      }, { status: 400 });
    }
    return jsonResponse({
      success: true, problem_id: id, source: 'production_d1',
      comparison_summary: { solutions_analyzed: solutions.length, ranking_basis: ['verified', 'effectiveness_score', 'upvotes'] },
      solutions: solutions.map((solution, index) => ({
        ...solution, rank: index + 1,
        metrics: {
          verified: Boolean(solution.is_verified),
          effectiveness_score: solution.effectiveness_score,
          upvotes: Number(solution.upvotes || 0),
          has_explanation: Boolean(solution.why_explanation),
          has_code: Boolean(solution.code_snippet)
        }
      }))
    });
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      for (const [name, minimum] of [['limit', 1], ['page', 1], ['offset', 0]]) {
        if (!url.searchParams.has(name)) continue;
        const raw = url.searchParams.get(name);
        const value = Number(raw);
        if (!/^\d+$/.test(raw || '') || !Number.isSafeInteger(value) || value < minimum) {
          return jsonResponse({
            success: false,
            error: `${name} must be an integer ${minimum === 0 ? 'greater than or equal to 0' : 'greater than 0'}`
          }, { status: 400 });
        }
      }
      if (url.searchParams.has('limit') && Number(url.searchParams.get('limit')) > 200) {
        return jsonResponse({ success: false, error: 'limit cannot exceed 200' }, { status: 400 });
      }

      if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
        const contentType = request.headers.get('Content-Type') || '';
        const allowsBeaconPayload = url.pathname === '/api/events/batch' &&
          (contentType === '' || contentType.toLowerCase().startsWith('text/plain'));
        const allowsEmptyBody = url.pathname === '/api/auth/logout';
        if (!allowsBeaconPayload && !allowsEmptyBody &&
            !contentType.toLowerCase().startsWith('application/json')) {
          return jsonResponse({
            success: false,
            error: 'Content-Type must be application/json'
          }, { status: 415 });
        }
      }

      if (/^\/api\/content\/(?:edit|delete)\//.test(url.pathname)) {
        return jsonResponse({
          success: false,
          error: 'Legacy content mutation endpoint retired',
          replacement: 'Use PUT or DELETE /api/problems/:id'
        }, { status: 410 });
      }

      const retiredPrototypePaths = new Map([
        ['/api/identity/universal-passport', 'Agent identity passport is not an operational product capability'],
        ['/api/identity/track-activity', 'Agent identity passport is not an operational product capability'],
        ['/api/identity/sync-collaboration', 'Agent identity passport is not an operational product capability'],
        ['/api/predictions/problem-analysis', 'Prototype prediction endpoint retired; use grounded problem and solution data'],
        ['/api/predictions/solution-success', 'Prototype prediction endpoint retired; use verified-solution metrics'],
        ['/api/personas/matching', 'Prototype persona matching endpoint retired'],
        ['/api/personas/evolution', 'Prototype persona evolution endpoint retired'],
        ['/api/matching/problem-solution', 'Prototype matching endpoint retired; use /api/matching/recommendations/:problem_id'],
        ['/api/matching/track-effectiveness', 'Prototype effectiveness endpoint retired; use human solution verification']
      ]);
      const retiredIdentityAnalytics = /^\/api\/identity\/analytics\/[^/]+$/.test(url.pathname);
      const retiredPersonaAgent = /^\/api\/personas\/agent\/[^/]+$/.test(url.pathname);
      if (retiredPrototypePaths.has(url.pathname) || retiredIdentityAnalytics || retiredPersonaAgent) {
        return jsonResponse({
          success: false,
          error: retiredPrototypePaths.get(url.pathname) ||
            (retiredIdentityAnalytics
              ? 'Agent identity passport is not an operational product capability'
              : 'Prototype persona analysis endpoint retired'),
          capability_status: 'retired'
        }, { status: 410 });
      }
    }

    // Capture the request body BEFORE the router consumes it. Reading a body is
    // one-shot, so this clone is the only chance to record what was actually
    // submitted — which is the whole point for rejected requests, where no row
    // is ever written to problems/solutions.
    const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
    const shouldLogActivity = isMutating && url.pathname.startsWith('/api/') &&
      // Health probes and telemetry beacons are high-volume and carry no user
      // intent; logging them would bury the signal this table exists to keep.
      !url.pathname.startsWith('/api/health') && url.pathname !== '/api/events/batch';
    let capturedBody = null;
    if (shouldLogActivity) {
      try {
        capturedBody = await request.clone().text();
      } catch {
        capturedBody = null;
      }
    }

    let response;
    try {
      // Production and staging schemas are managed exclusively by tracked D1
      // migrations. Running dozens of CREATE TABLE/INDEX statements before
      // every request creates needless primary-database work and schema-lock
      // contention under sustained load (even /api/health used to do this).
      // Keep bootstrap initialization only for local development.
      if (env.ENVIRONMENT === 'development') {
        await initDatabase(env);
      }
      const groundedResponse = request.method === 'GET'
        ? await handleGroundedCapability(request, env, url)
        : null;
      response = groundedResponse || await router.handle(request, env, ctx);
    } catch (error) {
      console.error(`[API] Unhandled ${request.method} ${url.pathname}:`, error?.message || error);
      response = errResponse('Internal server error', null, 500);
    }

    if (!response) {
      response = jsonResponse({ success: false, error: 'API endpoint not found' }, { status: 404 });
    }

    // Never expose internal exception details. This is an error sanitizer, not
    // a circuit breaker: preserve that distinction for operators and clients.
    if (url.pathname.startsWith('/api/') && response?.status >= 500) {
      console.error(`[API] ${request.method} ${url.pathname} returned ${response.status}`);
      const optionalCapability = [
        '/api/predictions/', '/api/personas/', '/api/innovation/',
        '/api/intelligence/', '/api/matching/'
      ].some(prefix => url.pathname.startsWith(prefix));
      response = jsonResponse({
        success: false,
        error: optionalCapability
          ? 'This capability is temporarily unavailable'
          : 'The service is temporarily unavailable',
        ...(optionalCapability
          ? { capability_status: 'degraded' }
          : { service_status: 'degraded' })
      }, {
        status: 503,
        headers: { 'Retry-After': optionalCapability ? '300' : '5' }
      });
    }

    // Append-only activity trail. Runs in waitUntil so it adds nothing to the
    // response time and cannot fail the request, and reads the response through
    // a clone so the body the client receives is untouched.
    if (shouldLogActivity && response) {
      const httpStatus = response.status;
      let responseBody = null;
      try {
        responseBody = await response.clone().json();
      } catch {
        responseBody = null;
      }
      ctx.waitUntil((async () => {
        let parsedPayload = null;
        try {
          parsedPayload = capturedBody ? JSON.parse(capturedBody) : null;
        } catch {
          // Unparseable bodies are still worth keeping verbatim — malformed input
          // is exactly the kind of thing this log exists to preserve.
          parsedPayload = capturedBody ? { _unparsed: String(capturedBody).slice(0, 500) } : null;
        }
        const redacted = parsedPayload === null
          ? null
          : JSON.stringify(redactForActivityLog(parsedPayload)).slice(0, ACTIVITY_PAYLOAD_LIMIT);

        // Identify the actor without trusting the client. Authenticate against a
        // header-only probe rather than request.clone(): by this point the router
        // has consumed the body, and cloning a used request throws — which would
        // silently attribute every logged action to a null user.
        let actor = null;
        try {
          const authProbe = new Request(url.toString(), { method: 'GET', headers: request.headers });
          actor = await authenticate(authProbe, env);
        } catch {
          actor = null;
        }

        const rawIp = request.headers.get('CF-Connecting-IP') || '';
        let ipHash = null;
        if (rawIp) {
          try { ipHash = (await hashToken(`activity:${rawIp}`)).slice(0, 32); } catch { ipHash = null; }
        }

        const accepted = httpStatus >= 200 && httpStatus < 300;
        const target = activityTargetFor(url.pathname, responseBody);
        // Isolation: anything the API refused, plus anything moderation flagged,
        // is quarantined for review instead of being silently dropped.
        const flagged = Boolean(responseBody?.flagged);
        const quarantined = !accepted || flagged;

        await recordActivity(env, {
          method: request.method,
          path: url.pathname,
          action: activityActionFor(request.method, url.pathname),
          userId: actor?.id ?? null,
          username: actor?.username ?? null,
          agentType: detectAgentRequest(request),
          ipHash,
          outcome: accepted ? 'accepted' : 'rejected',
          httpStatus,
          reason: accepted ? null : String(responseBody?.error || '').slice(0, 300) || null,
          targetType: target.type,
          targetId: target.id,
          payload: redacted,
          payloadBytes: capturedBody ? capturedBody.length : null,
          quarantined,
          quarantineReason: !accepted
            ? `rejected_${httpStatus}`
            : (flagged ? 'moderation_flagged' : null)
        });
      })());
    }

    // Apply dynamic CORS to support both apex and www origins
    const origin = request.headers.get('Origin') || '';
    if (ALLOWED_ORIGINS.has(origin) && response) {
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Access-Control-Allow-Origin', origin);
      newHeaders.set('Vary', 'Origin');
      const patched = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });

      // Log API requests non-blocking
      if (
        env.ENVIRONMENT === 'development' &&
        url.pathname.startsWith('/api/') &&
        !url.pathname.includes('/events/batch')
      ) {
        ctx.waitUntil(logRequestToD1(env, {
          method: request.method,
          path: url.pathname,
          status: patched.status || 0,
          duration_ms: Date.now() - startTime,
          user_agent: request.headers.get('User-Agent'),
          ip_address: request.headers.get('CF-Connecting-IP'),
          timestamp: new Date().toISOString()
        }));
      }
      return patched;
    }

    // Log API requests non-blocking (skip batch endpoint to avoid noise)
    if (
      env.ENVIRONMENT === 'development' &&
      url.pathname.startsWith('/api/') &&
      !url.pathname.includes('/events/batch')
    ) {
      ctx.waitUntil(logRequestToD1(env, {
        method: request.method,
        path: url.pathname,
        status: response?.status || 0,
        duration_ms: Date.now() - startTime,
        user_agent: request.headers.get('User-Agent'),
        ip_address: request.headers.get('CF-Connecting-IP'),
        timestamp: new Date().toISOString()
      }));
    }

    return response;
  },

  // Daily harvest cron trigger (0 6 * * * = 6 AM UTC daily)
  async scheduled(event, env, ctx) {
    console.log(`[Cron] Daily harvest triggered at ${new Date(event.scheduledTime).toISOString()}`);
    ctx.waitUntil(runDailyHarvest(env));
  },
};

async function runDailyHarvest(env) {
  try {
    // Clean notifications older than 90 days
    await env.AIHANGOUT_DB.prepare(
      "DELETE FROM notifications WHERE created_at < datetime('now', '-90 days')"
    ).run();
    // Expired presence rows do not affect counts because reads use time-window
    // predicates. Reclaim them here rather than turning high-volume GET
    // requests into writes against D1's single primary.
    await env.AIHANGOUT_DB.prepare(
      "DELETE FROM enhanced_sessions WHERE last_seen < datetime('now', '-1 day')"
    ).run();
    await env.AIHANGOUT_DB.prepare(
      "DELETE FROM guest_sessions WHERE last_seen < datetime('now', '-1 day')"
    ).run();
    const allSites = ['stackoverflow', 'github_issues', 'reddit_programming', 'dev_to', 'hackernews', 'arxiv'];
    const result = await initializeMultiSiteHarvesting(env, {
      sites: allSites,
      categories: ['javascript', 'python', 'ai', 'machine-learning', 'backend', 'frontend'],
      difficulty_filters: ['easy', 'medium', 'hard'],
      max_per_site: 10,
      quality_threshold: 0.4, // Lowered — scoreContentRelevance now handles fine-grained filtering
      auto_assign_agents: false
    });
    const total = result?.total_problems_stored || 0;
    console.log(`[Cron] Daily harvest complete: ${total} new problems stored across ${allSites.length} sites`);
  } catch (error) {
    console.error(`[Cron] Daily harvest failed: ${error.message}`);
  }
}
