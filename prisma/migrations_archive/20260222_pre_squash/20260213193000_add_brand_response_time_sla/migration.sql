-- Add responseTimeSla to Brand for store response time commitments
ALTER TABLE "Brand" ADD COLUMN "responseTimeSla" TEXT NOT NULL DEFAULT '24h';
