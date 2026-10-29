# Human registration checks — 2026-10-14

## Live production results

Worked: ten new synthetic accounts were created through the actual registration
form with the default Human selection. Account IDs are 312–321, usernames
`humanqa_mv8hog7m_01` through `_10`. One registration used desktop Chrome; nine
used phone-sized Chrome viewports (requested widths 390 and 430 pixels). They are
not physical-phone or mobile-Safari tests. Reserved `example.invalid` addresses
were used; mailbox verification is not part of these results. No posts/messages
were created. Credentials are retained only in a private Windows DPAPI file.

Each success was read back from the authenticated UI. The production database
independently returned all ten accounts with `ai_agent_type: human`, and ten
`user_registration` analytics records. These test accounts must be excluded from
customer adoption metrics.

Failed, then Worked: account 6 initially displayed "Too many requests. Please
try again later." It succeeded after leaving the registration limiter idle.
The KV limiter refreshes a 60-second expiry on every attempt; continuing to
retry extends that wait. This review did not change limits or limiter behavior.
The same helper also has a longer IP window, while its response always says
`Retry-After: 60`; the new UI therefore says **at least** one minute and explains
that a longer wait can be needed. There was no observed hourly-limit rejection
in this run. This is a reproduced signup obstacle, not an attribution of the
owner's exact phone failure.

Failed usability check: deliberately submitting the existing tenth account
produced only the generic "Registration failed. Please check your details and
try again." popup, twice. The form did not retain a visible explanation of the
server failure. Two mounted toast renderers caused the duplicate popups.

## Prepared UI repair

- Keep server errors in a focused, persistent panel by the submit button.
- Explain duplicate details without confirming whether a particular email exists;
  provide Sign in, Reset password and Report signup problem links.
- Explain network errors, service errors, blocked requests and rate limits.
- Bound the signup request to 20 seconds and explain that an account might have
  been created even if its response was lost. Do not automatically retry.
- Validate username characters, email, 12–128-character password length and
  password confirmation before sending. Disable phone autocorrection for account
  identifiers, trim surrounding username/email whitespace, preserve passwords.
- Preserve entered fields after rejection, and remove duplicate toast rendering.
- Record registration submission, validation-failure and client-result events
  with status/duration. These additions do not log the entered username, email
  or password. The existing server registration event remains separate.

Authentication rules, JWT handling, API registration logic, CORS/CSP, database
bindings and rate thresholds are unchanged. The auth store's only changes are
request timeout and handing error presentation to the form.

## Acceptance evidence

`browser-results.json`: ten successful live registrations plus the retained
initial rate-limit failure for account 6.

`database-check-verified.json`: read-only production D1 account-type and event
verification. A first query incorrectly requested a nonexistent `created_at`
column; that failed query remains separately in private `.local` evidence.

`local-browser-acceptance.json`: actual compiled frontend in Chrome at phone
width, with a loopback HTTP fixture server returning controlled failures. It
checks username guidance, duplicate response, rate-limit response, service
failure, dropped connection, a real pending-request timeout, focused errors,
enabled retry, retained fields and the receiving password-reset page. The
viewport has 375 pixels of content width after the scrollbar, without horizontal
overflow. The browser tool's wait expired before the 20-second application
timeout; a subsequent visible readback confirmed the timeout explanation and
enabled button. This tool wait was not an application failure.

Screenshots retain the live generic duplicate error, the repaired local
duplicate explanation and the repaired local timeout explanation.
The first duplicate capture still showed the preceding username-validation
frame; it is retained as `username-validation.png`. The final duplicate screenshot
was visually inspected against the persistent alert before saving.

Commands run:

```text
node scripts/test-registration-feedback.mjs  # 9 passed
node scripts/test-chat-analytics.mjs         # 5 passed
npm test                                    # 57 Worker/D1 tests passed
node crucible_tests.js                       # all passed
npm run build:frontend                      # passed
wrangler deploy --env production --dry-run  # passed
```

Run the local error scenarios with the built assets and
`node scripts/serve-registration-fixtures.mjs`. This binds only to loopback;
`.local/signup-test-20261014/fixture-mode.json` selects duplicate, rate_limit,
server, network or timeout. It drains but never records submitted credentials.

## Release state

The ten accounts exist on production. The UI repair is committed/prepared,
but not deployed. This branch also contains the previously prepared chat and
analytics reliability fixes. Publishing this build would release both changes.
Production approval and a subsequent public-browser error check are the next
release steps under AGENTS.md. The live site still uses its prior error display.
The original `live_countdown_test` browser session was restored and verified.
The owned loopback fixture server was stopped after PID, birth and executable
checks; the ten production test accounts remain available.
