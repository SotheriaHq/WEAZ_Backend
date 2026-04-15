-- AlterEnum
ALTER TYPE "PaymentSubjectType" ADD VALUE 'UNIFIED_CHECKOUT';

-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN     "unifiedCheckoutManifestJson" JSONB;
