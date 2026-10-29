import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transform } from 'esbuild';
const { code } = await transform(readFileSync('frontend/src/utils/registrationFeedback.ts', 'utf8'), { loader: 'ts', format: 'cjs' });
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports });
const { registrationErrorMessage: message, registrationValidation: validate } = module.exports;
const valid = { username: 'human_test', email: 'human@example.invalid', password: 'local-only-passphrase', confirmPassword: 'local-only-passphrase' };
test('accepts human form values with surrounding username/email whitespace', () => assert.equal(validate({ ...valid, username: ' human_test ', email: ' human@example.invalid ' }), ''));
test('explains spaces in usernames before contacting the API', () => assert.match(validate({ ...valid, username: 'Human Person' }), /Remove spaces/));
test('explains malformed email and both password length boundaries', () => {
  assert.match(validate({ ...valid, email: 'bad-address' }), /valid email/);
  assert.match(validate({ ...valid, password: 'short' }), /at least 12/);
  assert.match(validate({ ...valid, password: 'a'.repeat(129) }), /128/);
});
test('explains confirmation mismatch', () => assert.match(validate({ ...valid, confirmPassword: 'different value' }), /do not match/));
test('duplicate details offer sign-in/reset without identifying an existing email', () => assert.match(message({ response: { status: 409 } }), /may already be registered.*signing in or resetting/));
test('rate limit respects retry duration and warns against repeated retries', () => {
  assert.match(message({ response: { status: 429, headers: { 'retry-after': '60' } } }), /at least 1 minute without trying again/);
  assert.match(message({ response: { status: 429, headers: { 'retry-after': '120' } } }), /at least 2 minutes/);
});
test('connection loss and timeout give a recovery action without claiming account absence', () => {
  assert.match(message({ code: 'ERR_NETWORK' }), /in case your account was created/);
  assert.match(message({ code: 'ECONNABORTED' }), /timed out.*signing in first/);
});
test('service errors do not disclose raw backend details', () => {
  const result = message({ response: { status: 503, data: { error: 'private database internals' } } });
  assert.match(result, /could not finish signup/); assert.ok(!result.includes('database'));
});
test('known password rejection is actionable; arbitrary response text is not echoed', () => {
  assert.match(message({ response: { status: 400, data: { error: 'Choose a less common password' } } }), /less common password/);
  assert.ok(!message({ response: { status: 400, data: { error: '<script>raw</script>' } } }).includes('<script>'));
});
