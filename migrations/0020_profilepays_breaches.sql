-- Removal is a durable event, not something a later polling snapshot may erase.
ALTER TABLE pp_assignments ADD COLUMN breached_at INTEGER;
ALTER TABLE pp_assignments ADD COLUMN breach_reason TEXT;

CREATE TRIGGER pp_profile_removed AFTER DELETE ON live_profile_links
BEGIN
  UPDATE pp_assignments SET stopped=1,
    breached_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),breach_reason='user_override'
  WHERE grant_id IN (SELECT id FROM pp_grants WHERE user_id=OLD.user_id)
    AND stopped=0 AND breached_at IS NULL
    AND lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
    AND (ends_at IS NULL OR ends_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER));
END;

CREATE TRIGGER pp_profile_changed AFTER UPDATE OF profile_id ON live_profile_links
WHEN NEW.profile_id IS NOT OLD.profile_id
BEGIN
  UPDATE pp_assignments SET stopped=1,
    breached_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),breach_reason='user_override'
  WHERE grant_id IN (SELECT id FROM pp_grants WHERE user_id=NEW.user_id)
    AND stopped=0 AND breached_at IS NULL
    AND lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
    AND (ends_at IS NULL OR ends_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER));
END;

CREATE TRIGGER pp_profile_added AFTER INSERT ON live_profile_links
BEGIN
  UPDATE pp_assignments SET stopped=1,
    breached_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),breach_reason='user_override'
  WHERE grant_id IN (SELECT id FROM pp_grants WHERE user_id=NEW.user_id)
    AND original_key IS NOT NEW.profile_id AND stopped=0 AND breached_at IS NULL
    AND lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
    AND (ends_at IS NULL OR ends_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER));
END;

CREATE TRIGGER pp_placement_removed AFTER UPDATE OF stopped ON pp_assignments
WHEN OLD.stopped=0 AND NEW.stopped=1 AND NEW.breached_at IS NULL
  AND NEW.lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  AND (NEW.ends_at IS NULL OR NEW.ends_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
BEGIN
  UPDATE pp_assignments SET breached_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),
    breach_reason='placement_removed' WHERE id=NEW.id;
END;

CREATE TRIGGER pp_breach_immutable BEFORE UPDATE ON pp_assignments
WHEN OLD.breached_at IS NOT NULL AND (
  NEW.breached_at IS NOT OLD.breached_at OR NEW.breach_reason IS NOT OLD.breach_reason OR NEW.stopped<>1)
BEGIN
  SELECT RAISE(ABORT,'Placement breach cannot be cleared');
END;
