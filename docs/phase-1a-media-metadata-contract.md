# Phase 1A Feed Media Metadata Contract

## Scope

The market feed media DTO continues to expose existing fields and routes. Phase 1A changes only the truthfulness of aspect metadata and avoids rebuilding the selected primary media asset twice.

## Contract

Each ready feed media asset returns:

- `width: number | null`
- `height: number | null`
- `aspectRatio: number | null`, computed only when both dimensions are positive
- `thumbnailUrl`, preferring the existing THUMB variant
- `previewUrl`, preferring CARD then DETAIL
- `displayUrl`, preferring DETAIL then ZOOM then CARD, with the existing original fallback
- `blurHash: null`
- `dominantColor: null`

Missing dimensions no longer become aspect ratio `1`. Existing clients remain compatible because the field is still present and JSON already permits `null` for optional metadata.

## Metadata gap

The current Prisma `FileUpload` and `FileVariant` models store dimensions but do not store blurhash or dominant color. The existing image pipeline does not produce those values. Adding persistence and image-worker extraction is a separate migration and processing change, so Phase 1A leaves both nullable rather than inventing data or deriving an unreliable color at request time.

## URL stability

The service prefers public display URLs through the existing upload service and uses temporary signed URLs only through the established fallback. Feed mapping now builds every collection media asset once and selects the primary asset from that result, avoiding duplicate URL generation for the primary entry. Signed URLs still carry their normal expiry; clients should use file/tier-based cache keys where possible.

## Verification

- `npm test -- src/collections/collections.service.spec.ts --runInBand`
- `npm run build`
- `git diff --check`

The focused service test verifies that unknown dimensions remain `null` and that known `1200 x 1600` dimensions still produce aspect ratio `0.75`.
