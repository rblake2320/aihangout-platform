-- Per-user opt-out for mobile-companion action-pending notifications,
-- matching the existing notify_new_follower/notify_vote_on_content/
-- notify_new_solution convention on user_settings.
ALTER TABLE user_settings ADD COLUMN notify_mobile_action_pending BOOLEAN DEFAULT TRUE;
