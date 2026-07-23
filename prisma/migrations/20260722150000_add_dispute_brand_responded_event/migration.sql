-- Timeline event emitted when a brand submits its single, structured response
-- to an admin-adjudicated dispute (read-only afterward). Additive enum value.
ALTER TYPE "CustomOrderTimelineEventType" ADD VALUE IF NOT EXISTS 'DISPUTE_BRAND_RESPONDED';
