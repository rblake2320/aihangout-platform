-- Durable audit trail for every notification decision, including preference suppression.
CREATE TABLE IF NOT EXISTS notification_delivery_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  actor_id INTEGER,
  notification_type TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  source_type TEXT,
  source_id TEXT,
  channel TEXT NOT NULL DEFAULT 'in_app',
  status TEXT NOT NULL CHECK (status IN ('created', 'refreshed', 'suppressed', 'failed')),
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (actor_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_user_created
  ON notification_delivery_log(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_source
  ON notification_delivery_log(source_type, source_id, notification_type);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_status_created
  ON notification_delivery_log(status, created_at);
