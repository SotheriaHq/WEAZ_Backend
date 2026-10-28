const { test } = require('node:test');
const assert = require('node:assert/strict');
require('ts-node').register({ transpileOnly: true });
const sharp = require('sharp');
const { assertCompleteRasterImage, assertSafeImageMetadata } = require('../src/media-processing/image-content-security');

test('valid raster uploads are fully decoded without mutating their bytes', async () => {
  for (const format of ['png', 'jpeg', 'webp']) {
    const bytes = await sharp({ create: { width: 32, height: 48, channels: 3, background: '#8623c1' } })[format]().toBuffer();
    const before = Buffer.from(bytes);
    await assertCompleteRasterImage(bytes);
    assert.deepEqual(bytes, before);
  }
});

test('raster magic bytes cannot disguise a truncated or malformed upload', async () => {
  for (const format of ['png', 'jpeg', 'webp']) {
    const bytes = await sharp({ create: { width: 32, height: 48, channels: 3, background: '#8623c1' } })[format]().toBuffer();
    await assert.rejects(() => assertCompleteRasterImage(bytes.subarray(0, Math.floor(bytes.length / 2))));
  }
  await assert.rejects(() => assertCompleteRasterImage(Buffer.from('GIF89a<script>alert(1)</script>')));
});

test('SVG and HTML never enter the raster decode/encoding pipeline', async () => {
  for (const source of ['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>', '<html><script>alert(1)</script></html>']) {
    await assert.rejects(() => assertCompleteRasterImage(Buffer.from(source)));
  }
});

test('dimension, total animation, frame-count and unsupported-format budgets are enforced', () => {
  for (const metadata of [
    { format: 'png', width: 10_000, height: 10_000 },
    { format: 'gif', width: 1_000, height: 100_000, pageHeight: 1_000, pages: 100 },
    { format: 'gif', width: 1, height: 201, pageHeight: 1, pages: 201 },
    { format: 'svg', width: 10, height: 10 },
    { format: 'png', width: 0, height: 20 },
  ]) assert.throws(() => assertSafeImageMetadata(metadata));
  assertSafeImageMetadata({ format: 'gif', width: 20, height: 40, pageHeight: 20, pages: 2 });
});
