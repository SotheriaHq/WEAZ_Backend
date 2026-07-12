-- Notification type for a client-side go-live/upload failure. When a brand
-- presses "Go Live" and media upload fails mid-way, a draft already exists on
-- the server; this durable, cross-device notification routes the owner back to
-- that draft to finish it (replaces the transient, unreadable failure toast).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CONTENT_PUBLISH_FAILED';
