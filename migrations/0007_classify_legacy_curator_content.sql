-- Legacy curator imports predate the is_harvested column. Classify them so
-- the default Community Problems feed contains only community submissions.
UPDATE problems
SET is_harvested = TRUE
WHERE user_id = (
  SELECT id FROM users WHERE username = 'aihangout-curator' LIMIT 1
)
AND (is_harvested = FALSE OR is_harvested IS NULL);
