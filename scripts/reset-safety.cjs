const path = require('node:path');
const fs = require('node:fs');

function parseResetArgs(argv) {
  const flags = new Set();
  const values = {};
  const booleanNames = new Set(['confirm', 'skip-db', 'skip-bucket', 'skip-local-uploads', 'skip-seed', 'admin-only-seed', 'wipe-bucket', 'wipe-local-uploads']);
  const valueNames = new Set(['target', 'expect-host', 'expect-database', 'expect-bucket']);
  for (const argument of argv) {
    const match = /^--([a-z-]+)(?:=(.+))?$/.exec(argument);
    if (!match || flags.has(match[1]) || Object.hasOwn(values, match[1])) throw new Error('Invalid or duplicate reset option');
    if (booleanNames.has(match[1]) && match[2] === undefined) flags.add(match[1]);
    else if (valueNames.has(match[1]) && match[2] !== undefined) values[match[1]] = match[2];
    else throw new Error('Unknown reset option; values use --name=value');
  }
  if ((flags.has('wipe-bucket') && flags.has('skip-bucket')) || (flags.has('wipe-local-uploads') && flags.has('skip-local-uploads'))) throw new Error('Conflicting storage reset options');
  return {
    confirm: flags.has('confirm'), skipDb: flags.has('skip-db'),
    skipBucket: !flags.has('wipe-bucket'), skipLocalUploads: !flags.has('wipe-local-uploads'),
    skipSeed: flags.has('skip-seed'), adminOnlySeed: flags.has('admin-only-seed'),
    target: values.target, expectedHost: values['expect-host'],
    expectedDatabase: values['expect-database'], expectedBucket: values['expect-bucket'],
  };
}

function validateResetTarget(options, env) {
  if (!options.confirm) throw new Error('Reset requires --confirm');
  if (!['local', 'sit'].includes(options.target)) throw new Error('Reset requires --target=local or --target=sit');
  let databaseLabel = 'skip';
  if (!options.skipDb) {
    let url;
    try { url = new URL(env.DATABASE_URL); } catch { throw new Error('A valid DATABASE_URL is required'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Only PostgreSQL reset targets are supported');
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!database || ['postgres', 'template0', 'template1'].includes(database)) throw new Error('System databases cannot be reset');
    if (url.hostname !== options.expectedHost || database !== options.expectedDatabase) throw new Error('Database does not match --expect-host and --expect-database');
    if (options.target === 'local' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local reset requires a loopback database');
    if (options.target === 'sit' && (env.RESET_SIT_DATABASE_HOST !== url.hostname || env.RESET_SIT_DATABASE_NAME !== database)) throw new Error('SIT reset must also match independently configured RESET_SIT_DATABASE_HOST and RESET_SIT_DATABASE_NAME');
    databaseLabel = `${url.hostname}:${url.port || '5432'}/${database}`;
    const passwordLength = String(env.SYSTEM_ADMIN_PASSWORD || '').length;
    if (!options.skipSeed && (passwordLength < 16 || passwordLength > 128)) throw new Error('Configure a 16–128 character SYSTEM_ADMIN_PASSWORD securely before deleting the database');
  }
  return databaseLabel;
}

function resolveLocalUploads(repoRoot) {
  const root = fs.realpathSync(repoRoot);
  const uploads = path.resolve(root, 'uploads');
  if (path.dirname(uploads) !== root) throw new Error('Uploads path is outside the backend workspace');
  if (fs.existsSync(uploads) && (fs.lstatSync(uploads).isSymbolicLink() || fs.realpathSync(uploads) !== uploads)) throw new Error('Refusing to recursively remove redirected uploads');
  return uploads;
}

module.exports = { parseResetArgs, validateResetTarget, resolveLocalUploads };
