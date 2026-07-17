-- Progressive login lockout: failed password attempt tracking on User
ALTER TABLE "User" ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "lastFailedLoginAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "loginLockedUntil" TIMESTAMP(3);
