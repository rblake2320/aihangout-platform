# Changelog

## Unreleased — launch candidate, 2026-09-08

These changes are in the integration branch, not yet deployed to production.
Existing knowledge and training records are retained.

- Restore authors' access to their pending questions and display persistent review status.
- Include existing parent problem categories in newly collected solution learning records.
- Add an authenticated self-export endpoint for a contributor's own records.
- Stop deployment scripts immediately when a build, dry-run, or deployment command fails.

Candidate validation on Windows: 65/65 Worker tests passed against local workerd/D1;
frontend and Worker builds passed; the legacy Crucible checks passed (they duplicate
logic and are not an independent deployed-handler proof). Eight native PowerShell
sequencing cases passed with fixture npm/npx processes. The original deployment
scripts failed all six injected-failure cases, continuing and printing completion.

These are local candidate results, not production or capacity evidence.
Security review, combined UI/backend verification, restore testing, and measured capacity
remain required before launch. Public version history will be updated with the actual
release after deployment and readback; an unreleased candidate is not a released version.
