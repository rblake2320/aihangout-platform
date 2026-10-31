-- AIH-R7 step 2: accepted answer.
--
-- The asker marks one answer as accepted. Stored on the problem so the feed and the MCP tools
-- read it without a join. Validated in code (same problem, asker only). No foreign key, so an
-- answer removed later cannot break the problem row.
--
-- No triggers in this file (wrangler's remote migration splitter cannot apply them).

ALTER TABLE problems ADD COLUMN accepted_solution_id INTEGER;
