-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" UUID NOT NULL,
    "buyerId" UUID,
    "provider" TEXT NOT NULL,
    "providerMode" TEXT NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "channel" TEXT,
    "status" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "callbackUrl" TEXT,
    "authorizationUrl" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "orderIds" TEXT[],
    "requestSnapshot" JSONB,
    "responseSnapshot" JSONB,
    "nextAction" JSONB,
    "bankAccount" JSONB,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "expiresAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" UUID NOT NULL,
    "paymentAttemptId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_reference_key" ON "PaymentAttempt"("reference");

-- CreateIndex
CREATE INDEX "PaymentAttempt_buyerId_createdAt_idx" ON "PaymentAttempt"("buyerId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentAttempt_status_createdAt_idx" ON "PaymentAttempt"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentEvent_paymentAttemptId_createdAt_idx" ON "PaymentEvent"("paymentAttemptId", "createdAt");
