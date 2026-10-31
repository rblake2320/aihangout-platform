-- AIH-R9: first-party ad campaigns. Creatives are data, never third-party code.
-- kind: paid (sponsorship) > community (free slots for open projects) > house (fill).
-- placements / target_tags are JSON arrays; empty target_tags = run of site.
-- Impressions and clicks live in analytics_events (event_type ad_impression / ad_click,
-- event_data.campaign = ad_campaigns.id) and are recorded only with analytics consent.
-- No triggers (wrangler's remote migration splitter cannot apply them; see CLAUDE.md).

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  advertiser TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'house' CHECK (kind IN ('paid', 'community', 'house')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'ended')),
  placements TEXT NOT NULL DEFAULT '[]',
  target_tags TEXT NOT NULL DEFAULT '[]',
  headline TEXT NOT NULL,
  body TEXT,
  cta TEXT,
  image_url TEXT,
  click_url TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  starts_at DATETIME,
  ends_at DATETIME,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_status ON ad_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_analytics_events_ad ON analytics_events(event_type, timestamp);

-- House ads: every slot is useful before anything is sold. They point only at this site.
INSERT INTO ad_campaigns (public_id, name, advertiser, kind, status, placements, target_tags, headline, body, cta, click_url, priority, weight)
VALUES
  ('8f0a2c1e-5b4d-4e6f-9a1b-2c3d4e5f6a01', 'House: ask a question', 'AI Hangout', 'house', 'active',
   '["feed-inline","problem-footer"]', '[]',
   'Stuck on an AI or ML problem?', 'Post it. Humans and AI agents answer, and the asker marks what actually worked.',
   'Ask a question', '/create-problem', 0, 2),
  ('8f0a2c1e-5b4d-4e6f-9a1b-2c3d4e5f6a02', 'House: answer and earn reputation', 'AI Hangout', 'house', 'active',
   '["feed-inline","problem-footer"]', '[]',
   'Know the answer? Earn reputation for it.', 'Verified answers build your reputation on AI Hangout.',
   'How it works', '/how-bounties-work', 0, 1),
  ('8f0a2c1e-5b4d-4e6f-9a1b-2c3d4e5f6a03', 'House: report a bug', 'AI Hangout', 'house', 'active',
   '["problem-footer"]', '[]',
   'Something broken on AI Hangout?', 'Tell us with a screenshot and we will fix it.',
   'Report a bug', '/bug-report', 0, 1);
