const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const failures = [];

const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const fail = (message) => failures.push(message);

const assertIncludes = (relativePath, needle, message) => {
  const content = read(relativePath);
  if (!content.includes(needle)) fail(`${relativePath}: ${message}`);
};

const assertNotMatches = (relativePath, pattern, message) => {
  const content = read(relativePath);
  if (pattern.test(content)) fail(`${relativePath}: ${message}`);
};

assertIncludes('src/upload/upload.service.ts', 'getStablePublicDisplayUrl', 'public delivery must keep stable display URL preference');
assertIncludes('src/upload/upload.service.ts', 'getPublicDisplayUrl', 'public URL endpoint must keep explicit display URL policy');
assertIncludes('src/upload/upload.service.spec.ts', 'keeps production signed media on the R2 presigned URL path', 'production signing regression test must remain');
assertIncludes('src/upload/upload.service.spec.ts', 'denies public URL fallback for private collection media', 'private public-URL denial test must remain');
assertIncludes('src/upload/upload.service.spec.ts', 'always issues an owner-gated storage capability rather than returning a persisted local URL', 'all environments must use owner-gated storage capabilities');
assertIncludes('src/upload/upload.service.spec.ts', 'retains a recoverable staging intent and fails visibly when server storage is unavailable', 'storage failures must preserve recovery without falling back to local disk');

assertIncludes('src/designs/mappers/design-response.mapper.ts', 'sanitizePrivateMedia', 'explicit design mapper must sanitize private media');
assertIncludes('src/designs/mappers/design-response.mapper.ts', 'file.isPublic !== false', 'only private media should be stripped');
assertIncludes('src/designs/mappers/design-response.mapper.ts', 's3Key: null', 'private media storage keys must be stripped');
assertIncludes('src/designs/mappers/design-response.mapper.ts', 's3Url: null', 'private media storage URLs must be stripped');
assertIncludes('src/designs/mappers/design-response.mapper.ts', 'variants: sanitizedVariants', 'private media variant URLs must be stripped');
assertIncludes('src/designs/mappers/design-response.mapper.spec.ts', 'keeps private explicit design media owner-gated by omitting direct storage URLs', 'private media leak test must remain');

// This optional local-only tool was removed in f0a1377. If restored, its
// safety guards must still hold; normal CI verifies the tracked privacy tests.
if (fs.existsSync(path.join(repoRoot, 'scripts/seed-phase5c-private-media.ts'))) {
  assertIncludes('scripts/seed-phase5c-private-media.ts', 'THREADLY_PHASE5C_PRIVATE_MEDIA_FIXTURE', 'fixture script must require an explicit local flag');
  assertIncludes('scripts/seed-phase5c-private-media.ts', "NODE_ENV || '').toLowerCase() === 'production'", 'fixture script must refuse production');
  assertIncludes('scripts/seed-phase5c-private-media.ts', 'isSafeLocalDatabaseUrl(process.env.DATABASE_URL)', 'fixture script must refuse non-local databases');
  assertNotMatches('scripts/seed-phase5c-private-media.ts', /https:\/\/.+(amazonaws|s3)\./i, 'fixture script must not hardcode remote private media URLs');
}
assertIncludes('src/upload/upload.service.spec.ts', 'denies signed URLs for deleted or failed owned media', 'invalid media signing denial must remain');
assertIncludes('src/upload/upload.service.spec.ts', 'rejects cross-user and wrong-prefix presigned upload finalization attempts', 'cross-user upload denial must remain');

if (failures.length > 0) {
  console.error('Performance regression guard failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Performance regression guard passed.');
