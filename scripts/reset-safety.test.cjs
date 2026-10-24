const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseResetArgs, validateResetTarget, resolveLocalUploads } = require('./reset-safety.cjs');
const options = { confirm: true, target: 'local', expectedHost: 'localhost', expectedDatabase: 'wiez_test' };
const env = { DATABASE_URL: 'postgresql://user:do-not-log-this@localhost:5432/wiez_test?sslmode=disable', SYSTEM_ADMIN_PASSWORD: 'a-test-only-long-password' };

test('database reset leaves bucket and filesystem alone unless explicitly requested', () => {
  const parsed = parseResetArgs(['--confirm', '--target=local', '--expect-host=localhost', '--expect-database=wiez_test']);
  assert.equal(parsed.skipBucket, true); assert.equal(parsed.skipLocalUploads, true);
  assert.equal(parsed.expectedDatabase, 'wiez_test');
});
test('unknown, duplicate and conflicting options fail closed', () => {
  for (const args of [['--force'], ['--confirm', '--confirm'], ['--target=local', '--target=sit'], ['--wipe-bucket', '--skip-bucket']]) assert.throws(() => parseResetArgs(args));
});
test('display identity never includes credentials or URL query', () => assert.equal(validateResetTarget(options, env), 'localhost:5432/wiez_test'));
test('unconfirmed, unknown, mismatched or remote-local targets are refused', () => {
  for (const change of [{ confirm: false }, { target: 'production' }, { expectedHost: 'another' }, { expectedDatabase: 'other' }]) assert.throws(() => validateResetTarget({ ...options, ...change }, env));
  assert.throws(() => validateResetTarget({ ...options, expectedHost: 'db.example' }, { ...env, DATABASE_URL: 'postgresql://user:secret@db.example/wiez_test' }));
});
test('system database and absent seed credentials are refused before deletion', () => {
  assert.throws(() => validateResetTarget({ ...options, expectedDatabase: 'postgres' }, { ...env, DATABASE_URL: 'postgresql://user:secret@localhost/postgres' }));
  for (const password of ['', 'short', 'x'.repeat(129)]) assert.throws(() => validateResetTarget(options, { ...env, SYSTEM_ADMIN_PASSWORD: password }));
});
test('SIT requires independently matched configured identity', () => {
  const sit = { ...options, target: 'sit', expectedHost: 'sit-db.example' };
  const sitEnv = { ...env, DATABASE_URL: 'postgresql://user:secret@sit-db.example/wiez_test' };
  assert.throws(() => validateResetTarget(sit, sitEnv));
  assert.equal(validateResetTarget(sit, { ...sitEnv, RESET_SIT_DATABASE_HOST: 'sit-db.example', RESET_SIT_DATABASE_NAME: 'wiez_test' }), 'sit-db.example:5432/wiez_test');
});
test('recursive file target is fixed inside the resolved backend root', () => {
  const path = require('node:path'); const fs = require('node:fs');
  const root = fs.realpathSync(path.resolve(__dirname, '..'));
  assert.equal(resolveLocalUploads(root), path.join(root, 'uploads'));
});
