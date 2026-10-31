# Image quality requirements and verification

Revision: 29 October 2026.

As a brand, I want the texture, colour and transparency of my fashion images
preserved when WIEZ prepares them for display, so that shoppers can inspect my
work accurately on web and native.

## Required behavior

- Keep a valid original that already fits the actual upload ceiling. A desired
  byte-reduction percentage must not trigger another lossy generation.
- Resize to explicit display variants without enlargement, cropping or aspect
  ratio distortion. A thumbnail is not a replacement for the original master.
- Preserve transparent images as full-colour PNG and lossless WebP, including
  alpha. PNG compression must not enable palette quantization.
- Use near-lossless WebP for opaque display images and separately calibrated
  AVIF with 4:4:4 chroma. Codec quality values are settings, not percentages of
  retained human-perceived detail.
- Respect orientation, strip EXIF/private camera metadata and include the sRGB
  colour profile. Bound decoding, encoder time, retry count and pixel limits.
- Native preprocessing keeps valid originals, limits parallel encodes to two,
  preserves PNG/animation where applicable and retains an actionable upload
  validation path if a native codec is unavailable. Browser preprocessing uses
  verified lossless WebP or PNG before a high-quality over-budget fallback.

## Fixed defect

The server PNG encoder passed `effort: 9`. Sharp documents that PNG `effort`
enables palette output, so the supposedly lossless display variant was
quantized. The actual resized alpha fixture produced an indexed PNG and RGB
box-window SSIM 0.8950. Full-colour output now uses `palette: false` without
the palette-effort option; zlib compression and adaptive filtering remain.
This preserves lossless pixels rather than trying to hide loss with a higher
quality number. Existing originals and immutable published URLs are retained;
this change affects newly processed images. Reprocessing an existing image
must use the current versioned asset workflow.

## Reproducible evidence

Run `node scripts/verify-image-quality.cjs` from the backend. It calls the actual
`MediaProcessingService.generateVariantsIter`, checks all six variant sizes
and both formats against matching uncompressed display-size references, and
writes [production image evidence](../performance/image-production-quality.json).

The fixture set is deterministic: 512x768 high-frequency colour weave, dark
fabric detail and translucent edges. All 36 outputs must meet RGB 8x8
box-window SSIM >= 0.95, retain exact alpha, avoid enlargement, contain no EXIF
and retain the output colour profile. Transparent PNG/WebP must match every
reference RGBA value. The test includes identity and deliberately damaged
negative controls, full-colour PNG checks, source hashes and codec versions.
Both PR quality and deployment gates run it, alongside the codec unit suite.

Web preprocessing tests exercise passthrough, lossless fallback, real upload
ceilings, bounded attempts and resource cleanup. Native policy tests exercise
source preservation, format/MIME agreement, codec fallback, size checks,
temporary-file cleanup and concurrency. These client tests use mocked platform
encoders; real Android/iOS and browser codec acceptance must be recorded
separately. Synthetic images do not represent every fashion photograph.

The current production test passed 36/36 outputs with minimum RGB SSIM 0.9862
and exact transparent RGBA at each intended size. Neither SSIM nor an encoder
setting is a claim of “98.62% human quality.” File sizes and byte reduction are
reported for each output; a universal 90% byte reduction with 90–95% perceived
quality retention is not a defensible guarantee across arbitrary images.

References: [Sharp PNG palette settings](https://sharp.pixelplumbing.com/api-output/#png),
[Sharp WebP settings](https://sharp.pixelplumbing.com/api-output/#webp),
[Expo image manipulation](https://docs.expo.dev/versions/latest/sdk/imagemanipulator/).
