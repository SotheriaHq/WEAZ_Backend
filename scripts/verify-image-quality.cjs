require('dotenv').config({ quiet: true });
process.env.TS_NODE_TRANSPILE_ONLY = 'true';
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const {
  MediaProcessingService,
} = require('../src/media-processing/media-processing.service');
const { fixture, metrics } = require('./benchmark-image-quality.cjs');

async function main() {
  const service = new MediaProcessingService();
  const results = [];
  for (const kind of ['weave', 'dark', 'alpha']) {
    const input = fixture(kind, 512, 768);
    const image = sharp(input.pixels, { raw: input });
    const source =
      kind === 'alpha'
        ? await image.png().toBuffer()
        : await image
            .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
            .toBuffer();
    const probe = await service.probeImage(source);
    const started = performance.now();
    for await (const variant of service.generateVariantsIter(source, {
      mimeType: kind === 'alpha' ? 'image/png' : 'image/jpeg',
    })) {
      const decoded = await sharp(variant.buffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      assert.equal(decoded.info.width, variant.width);
      assert.equal(decoded.info.height, variant.height);
      assert(
        variant.width <= probe.width && variant.height <= probe.height,
        'no enlargement',
      );
      // Compare compression at the same intended display size. Deliberate
      // thumbnail resizing is reported as dimensions, not called codec loss.
      const reference = await sharp(source)
        .rotate()
        .withIccProfile('srgb')
        .resize({ width: variant.width, withoutEnlargement: true })
        .ensureAlpha()
        .raw()
        .toBuffer();
      assert.equal(reference.length, decoded.data.length);
      const fidelity = metrics(
        reference,
        decoded.data,
        variant.width,
        variant.height,
        4,
      );
      const alphaExact = reference.every(
        (value, index) => index % 4 !== 3 || decoded.data[index] === value,
      );
      assert(
        fidelity.rgbSsim8x8 >= 0.95,
        `${kind}/${variant.kind}/${variant.format}: SSIM ${fidelity.rgbSsim8x8} below 0.95`,
      );
      assert(
        alphaExact,
        `${kind}/${variant.kind}/${variant.format}: alpha changed`,
      );
      if (kind === 'alpha')
        assert.deepEqual(
          decoded.data,
          reference,
          'transparent variants must be pixel-exact',
        );
      const metadata = await sharp(variant.buffer).metadata();
      if (variant.format === 'PNG')
        assert.equal(metadata.isPalette, false, 'full-colour PNG required');
      assert.equal(metadata.exif, undefined, 'EXIF must not be retained');
      assert(metadata.icc, 'explicit colour profile required');
      results.push({
        fixture: kind,
        kind: variant.kind,
        format: variant.format,
        sourceSha256: createHash('sha256').update(source).digest('hex'),
        sourceBytes: source.length,
        outputBytes: variant.buffer.length,
        byteReduction: 1 - variant.buffer.length / source.length,
        width: variant.width,
        height: variant.height,
        encoderQuality: variant.quality,
        ...fidelity,
        alphaExact,
      });
    }
    console.log(
      `${kind}: production variants checked in ${Math.round(performance.now() - started)}ms`,
    );
  }
  assert.equal(
    results.length,
    36,
    'all six sizes and both formats must be checked',
  );
  // A grossly damaged output must not pass because of a broken metric.
  const control = fixture('weave', 64, 64);
  assert(metrics(control.pixels, control.pixels, 64, 64, 3).rgbSsim8x8 === 1);
  assert(
    metrics(control.pixels, Buffer.alloc(control.pixels.length), 64, 64, 3)
      .rgbSsim8x8 < 0.95,
  );
  const sourcePaths = [
    'src/media-processing/media-processing.service.ts',
    'src/media-processing/variant-profile.config.ts',
    'scripts/benchmark-image-quality.cjs',
    'scripts/verify-image-quality.cjs',
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      codecs: sharp.versions,
    },
    sourceHashes: Object.fromEntries(
      sourcePaths.map((file) => [
        file,
        createHash('sha256')
          .update(fs.readFileSync(path.resolve(__dirname, '..', file)))
          .digest('hex'),
      ]),
    ),
    limitations:
      'Deterministic 512x768 synthetic fabric/dark/alpha fixtures; actual production encoders, compared at each variant size. RGB 8x8 box-window SSIM is not a percentage of human quality. No promise of 90% byte reduction, representative photograph quality, browser/native codec parity, or production throughput.',
    results,
  };
  const destination = path.resolve(
    __dirname,
    '../docs/performance/image-production-quality.json',
  );
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      result: 'PASS',
      variants: results.length,
      minimumRgbSsim8x8: Math.min(...results.map((row) => row.rgbSsim8x8)),
      alphaExact: results.every((row) => row.alphaExact),
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
