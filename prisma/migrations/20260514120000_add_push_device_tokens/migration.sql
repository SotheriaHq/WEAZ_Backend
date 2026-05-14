CREATE TYPE "PushProvider" AS ENUM (
  'EXPO',
  'FCM',
  'APNS'
);

CREATE TYPE "PushPlatform" AS ENUM (
  'IOS',
  'ANDROID',
  'WEB',
  'UNKNOWN'
);

CREATE TABLE "PushDeviceToken" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "token" TEXT NOT NULL,
  "provider" "PushProvider" NOT NULL DEFAULT 'EXPO',
  "platform" "PushPlatform" NOT NULL DEFAULT 'UNKNOWN',
  "deviceId" TEXT,
  "deviceName" TEXT,
  "appVersion" TEXT,
  "expoProjectId" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "disabledReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PushDeviceToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushDeviceToken_token_key" ON "PushDeviceToken"("token");
CREATE INDEX "PushDeviceToken_userId_isActive_idx" ON "PushDeviceToken"("userId", "isActive");
CREATE INDEX "PushDeviceToken_token_idx" ON "PushDeviceToken"("token");

ALTER TABLE "PushDeviceToken"
ADD CONSTRAINT "PushDeviceToken_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
