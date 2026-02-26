-- Add StorePolicy table for store policies (hybrid storage)
CREATE TABLE "StorePolicy" (
    "_id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "shippingRegions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "processingTime" TEXT,
    "shippingMethods" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "freeShippingThreshold" DECIMAL(10, 2),
    "returnsAccepted" BOOLEAN NOT NULL DEFAULT true,
    "returnWindow" TEXT,
    "returnConditions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "refundMethod" TEXT,
    "responseTimeSla" TEXT NOT NULL DEFAULT '24h',
    "sizeChart" JSONB,
    "shippingRules" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorePolicy_pkey" PRIMARY KEY ("_id")
);

CREATE UNIQUE INDEX "StorePolicy_brandId_key" ON "StorePolicy"("brandId");
CREATE INDEX "StorePolicy_brandId_idx" ON "StorePolicy"("brandId");

ALTER TABLE "StorePolicy" ADD CONSTRAINT "StorePolicy_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
