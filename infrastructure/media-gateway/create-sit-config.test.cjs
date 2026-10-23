const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSitGatewayConfig } = require('./create-sit-config.cjs');

test('known workers.dev endpoint produces exact SIT binding and bounded public claims', () => {
  const result = createSitGatewayConfig({ baseUrl: 'https://wiez-sit-media-gateway.verified-account.workers.dev/media', transport: 'workers-dev' });
  assert.match(result, /name = "wiez-sit-media-gateway"/);
  assert.match(result, /bucket_name = "wiez-sit-media"/);
  assert.match(result, /binding = "MEDIA_BUCKET"/);
  assert.match(result, /workers_dev = true/);
  assert.match(result, /preview_urls = false/);
  const origins = require('../../docs/storage/r2-sit-cors.json')[0].AllowedOrigins.join(',');
  assert.ok(result.includes(`MEDIA_GATEWAY_ALLOWED_ORIGINS = ${JSON.stringify(origins)}`));
  assert.doesNotMatch(result, /MEDIA_GATEWAY_SECRET|R2_SECRET|ACCESS_KEY/);
});

test('custom route requires its verified zone and disables alternate workers.dev route', () => {
  const result = createSitGatewayConfig({ baseUrl: 'https://media-sit.example.com/media', transport: 'route', zoneName: 'example.com', jurisdiction: 'eu' });
  assert.match(result, /pattern = "https:\/\/media-sit.example.com\/media\/\*"/);
  assert.match(result, /workers_dev = false/);
  assert.match(result, /jurisdiction = "eu"/);
  assert.throws(() => createSitGatewayConfig({ baseUrl: 'https://media.other.com', transport: 'route', zoneName: 'example.com' }));
});

test('custom domain is scoped to one confirmed hostname', () => {
  const result = createSitGatewayConfig({ baseUrl: 'https://media-sit.example.com/media', transport: 'custom-domain', zoneName: 'example.com' });
  assert.match(result, /pattern = "media-sit.example.com", custom_domain = true/);
});

test('unverified routes, provider origins and credential-bearing URLs fail closed', () => {
  for (const baseUrl of ['http://media.example.com', 'https://user:password@media.example.com', 'https://media.example.com?sig=secret', 'https://media.example.com:444', 'https://pub-1.r2.dev', 'https://account.r2.cloudflarestorage.com', 'https://bucket.s3.amazonaws.com']) {
    assert.throws(() => createSitGatewayConfig({ baseUrl, transport: 'custom-domain', zoneName: 'example.com' }));
  }
  assert.throws(() => createSitGatewayConfig({ baseUrl: 'https://another-worker.account.workers.dev', transport: 'workers-dev' }));
  assert.throws(() => createSitGatewayConfig({ baseUrl: 'https://media.example.com', transport: 'route' }));
});
