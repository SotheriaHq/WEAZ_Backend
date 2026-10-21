const sharp = require('sharp');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

// Deterministic stress fixtures, not a substitute for a consented fashion-photo corpus.
function fixture(kind, width = 512, height = 768) {
  const channels = kind === 'alpha' ? 4 : 3;
  const pixels = Buffer.alloc(width * height * channels);
  const palette = [[174, 28, 63], [230, 169, 30], [22, 84, 148], [25, 136, 93]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * channels;
      const tone = 0.65 + 0.35 * Math.sin(Math.PI * x / width);
      const colour = palette[(Math.floor(x / 12) + Math.floor(y / 19)) % 4];
      const weave = Math.sin(x * 1.7) * Math.cos(y * 1.3) * 8;
      for (let c = 0; c < 3; c++) {
        const value = kind === 'dark'
          ? 8 + c * 9 + y / height * 45 + weave * 0.4
          : colour[c] * tone + weave + (x % 31 < 2 ? 45 : 0);
        pixels[index + c] = Math.max(0, Math.min(255, Math.round(value)));
      }
      if (channels === 4) pixels[index + 3] = Math.min(255, Math.max(0, Math.round((x - 40) * 3)));
    }
  }
  return { pixels, width, height, channels };
}

// Mean RGB SSIM with non-overlapping 8x8 box windows and population covariance.
// This is an explicit diagnostic metric, not a percentage of human perception.
function metrics(reference, result, width, height, channels) {
  let total = 0;
  let windows = 0;
  let squaredError = 0;
  let maximumError = 0;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      for (let c = 0; c < Math.min(channels, 3); c++) {
        let a = 0, b = 0, aa = 0, bb = 0, ab = 0, count = 0;
        for (let dy = 0; dy < 8 && y + dy < height; dy++) {
          for (let dx = 0; dx < 8 && x + dx < width; dx++) {
            const index = ((y + dy) * width + x + dx) * channels + c;
            const av = reference[index], bv = result[index];
            a += av; b += bv; aa += av * av; bb += bv * bv; ab += av * bv; count++;
            const error = Math.abs(av - bv);
            squaredError += error * error;
            maximumError = Math.max(maximumError, error);
          }
        }
        a /= count; b /= count;
        const va = Math.max(0, aa / count - a * a);
        const vb = Math.max(0, bb / count - b * b);
        const covariance = ab / count - a * b;
        total += ((2 * a * b + c1) * (2 * covariance + c2)) /
          ((a * a + b * b + c1) * (va + vb + c2));
        windows++;
      }
    }
  }
  const mse = squaredError / (width * height * Math.min(channels, 3));
  return { rgbSsim8x8: total / windows, psnrDb: mse ? 10 * Math.log10(255 ** 2 / mse) : null, maximumRgbError: maximumError };
}

async function main() {
  const cases = [
    ['webp-86-effort5', (image) => image.webp({ quality: 86, effort: 5, smartSubsample: true })],
    ['webp-90-effort5', (image) => image.webp({ quality: 90, effort: 5, smartSubsample: true })],
    ['webp-94-effort4', (image) => image.webp({ quality: 94, effort: 4, smartSubsample: true })],
    ['webp-near-lossless90-effort4', (image) => image.webp({ quality: 90, nearLossless: true, effort: 4 })],
    ['webp-near-lossless90-exact', (image) => image.webp({ quality: 90, nearLossless: true, exact: true, alphaQuality: 100, effort: 4 })],
    ['webp-lossless-exact', (image) => image.webp({ lossless: true, exact: true, alphaQuality: 100, effort: 4 })],
    ['avif-86-effort6', (image) => image.avif({ quality: 86, effort: 6, tune: 'psnr' })],
    ['avif-75-effort4', (image) => image.avif({ quality: 75, effort: 4, tune: 'psnr' })],
  ];
  const results = [];
  for (const kind of ['weave', 'dark', 'alpha']) {
    const source = fixture(kind);
    const sourcePng = await sharp(source.pixels, { raw: source }).png().toBuffer();
    if (metrics(source.pixels, source.pixels, source.width, source.height, source.channels).rgbSsim8x8 !== 1)
      throw new Error('Identity SSIM must equal one');
    for (const [name, encode] of cases) {
      const started = performance.now();
      const encoded = await encode(sharp(sourcePng)).toBuffer();
      const encodeMs = performance.now() - started;
      let decoded = sharp(encoded);
      decoded = source.channels === 4 ? decoded.ensureAlpha() : decoded.removeAlpha();
      const result = await decoded.raw().toBuffer();
      const row = { fixture: kind, candidate: name, inputBytes: sourcePng.length,
        inputSha256: createHash('sha256').update(sourcePng).digest('hex'),
        bytes: encoded.length, encodeMs, ...metrics(source.pixels, result, source.width, source.height, source.channels),
        alphaExact: source.channels !== 4 || source.pixels.every((value, index) => index % 4 !== 3 || result[index] === value),
      };
      results.push(row);
      console.log(`${kind} ${name}: SSIM=${row.rgbSsim8x8.toFixed(4)} bytes=${row.bytes} encode=${encodeMs.toFixed(1)}ms alpha=${row.alphaExact}`);
    }
  }
  const output = path.resolve(__dirname, '../docs/performance/image-quality-candidates-2026-10-21.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), sharp: sharp.versions,
    limitations: 'Synthetic 512x768 stress fixtures; one timed encode per candidate; RGB box-window SSIM is not human quality percentage or a production capacity benchmark.', results }, null, 2) + '\n');
}

module.exports = { fixture, metrics };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
