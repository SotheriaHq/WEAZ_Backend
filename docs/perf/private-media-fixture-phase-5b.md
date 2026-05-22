# Phase 5B Private Signed-Media Fixture

Date: 2026-05-22

## Status

Private signed-media success validation remains blocked in the current local environment.

Phase 5B discovery confirmed the important contract shape:

- `GET /uploads/public-url/:fileId` is public-read only when the upload is explicitly public, linked to a public published collection, or linked to public identity media.
- `GET /uploads/signed-url/:fileId` is authenticated and owner-gated by `fileUpload.userId`.
- Signed URLs expire after one hour.
- Existing READY non-public file records in the local database are not owned by the active authenticated browser test user.
- Some existing non-public records are attached to public published collections, so they are not valid private-fallback fixtures because the public URL path may be allowed.
- The Phase 5B upload attempt did not complete in this workspace and did not create a `phase-5b-private.png` record or `Phase 5B Private Media Fixture` design.

No authorization rule was weakened and no production data was changed.

## Required Fixture Shape

A valid fixture must satisfy all of these:

- Local/dev/test database only.
- File upload has `status = READY`.
- File upload has `isPublic = false`.
- File upload is owned by the authenticated test user or by that user's brand owner session.
- File upload is not linked to a public published collection or public identity media.
- The file appears in a private design/detail or collection/detail flow reachable by the authorized user.
- The public URL endpoint denies or returns no usable public URL.
- The signed URL endpoint succeeds for the owner.
- A different authenticated user cannot access the signed URL.

## Preferred Creation Path

Use the real application upload and design/collection creation path in a local/dev environment:

1. Start the backend with local/dev environment variables.
2. Authenticate as the intended fixture owner.
3. Upload a small image through `POST /uploads/post-image`.
4. Confirm a `FileUpload` row exists with:
   - owner equal to the authenticated user,
   - `status = READY`,
   - `isPublic = false`.
5. Create a private design or private collection using that file.
6. Open the private detail flow while authenticated as the owner.
7. Confirm:
   - public URL lookup is denied or unavailable,
   - signed URL lookup succeeds,
   - the media displays,
   - the signed URL is not printed in logs or persisted beyond its TTL.
8. Log in as another user and confirm the signed URL endpoint is denied without request loops.

## Validation Commands

Use the client network tracer for the owner session:

```js
window.__THREADLY_NETWORK_TRACE__?.clear()
```

Open the private design/detail or collection/detail flow, then run:

```js
window.__THREADLY_NETWORK_TRACE__?.printSummary()
```

Expected:

- Public media does not request signed URL.
- Private media requests `GET /uploads/signed-url/:fileId` once for the owner.
- Unauthorized access fails cleanly.
- Signed URL 400 spam remains 0.
- Cache-busted/no-store calls remain 0.

## Current Blocker

The current active test session does not own a qualifying READY private media record, and the endpoint correctly denies non-owner signed access. A real fixture must be created by upload as the target test user, or the active test session must be switched to a user that owns a qualifying private record.
