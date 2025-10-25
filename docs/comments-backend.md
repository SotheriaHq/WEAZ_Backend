Comment System v2 (Backend)

Overview
- Targets: POST, COLLECTION, COLLECTION_MEDIA.
- Depth: max 2 levels (0=top-level, 1=reply, 2=sub-reply). Reject deeper.
- Mirroring: On a media item view, show media comments + collection comments. Collection comments count at collection scope only.
- No caching in this phase; queues optional later. JWT required.

Data Model (Prisma)
- enum `CommentTarget`: POST | COLLECTION | COLLECTION_MEDIA
- model `CommentV2`:
  - id, targetType, targetId, userId, parentId?, depth
  - contentRaw, contentSanitized, likeCount, replyCount
  - createdAt, updatedAt, editedAt?, deletedAt?, version
  - relations: parent, children, user, likes
  - indexes: (targetType,targetId,createdAt), (parentId,createdAt)
- model `CommentV2Like`:
  - id, commentId, userId, createdAt
  - unique(commentId,userId)
- Counters (denormalized):
  - Post.commentsCount, Collection.commentsCount, CollectionMedia.commentsCount

Routes (v1)
- Create:
  - POST `/api/v1/posts/:postId/comments`
  - POST `/api/v1/collections/:collectionId/comments`
  - POST `/api/v1/collections/media/:mediaId/comments`
  - Body: `{ content: string (1-500), parentId?: uuid }`
- List (top-level; preload latest 2 replies):
  - GET `/api/v1/posts/:postId/comments?cursor=&limit=`
  - GET `/api/v1/collections/:collectionId/comments?cursor=&limit=`
  - GET `/api/v1/collections/media/:mediaId/comments?cursor=&limit=`
  - Returns `{ items, hasNextPage, endCursor }` with `children` and `isLikedByMe` on visible nodes
- Replies:
  - GET `/api/v1/comments/:id/replies?cursor=&limit=`
- Likes:
  - POST `/api/v1/comments/:id/like` (toggle)
  - GET `/api/v1/comments/:id/is-liked`
- Delete (soft):
  - DELETE `/api/v1/comments/:id` (author or target owner)
- Stats:
  - GET `/api/v1/comments/:id/stats` → `{ likeCount, replyCount }`

Validation & Rules
- Content sanitized server-side (simple HTML escaping now; pluggable sanitize profile later).
- Parent must share same target (type+id); parent.depth must be < 2.
- Soft delete replaces `contentSanitized` with `[deleted]` and sets `deletedAt`.

Realtime
- Socket rooms: `${targetType}:${targetId}` and `COMMENT:{commentId}`.
- Events:
  - `comment.created` → { targetType, targetId, commentId, userId, at }
  - `comment.deleted` → { commentId, at }
  - `comment.liked` → { commentId, userId, likeCount, at, clientEventId? }

Files
- Module: `src/commentsv2/commentsv2.module.ts`
- Controller: `src/commentsv2/commentsv2.controller.ts`
- Service: `src/commentsv2/commentsv2.service.ts`
- DTOs: `src/commentsv2/dto.ts`

Future (Phase 3+)
- Redis caching (60s) for list/replies/stats.
- BullMQ workers for notifications, analytics, cache invalidation.
- Rich sanitization (sanitize-html allowlist) and moderation reports.

