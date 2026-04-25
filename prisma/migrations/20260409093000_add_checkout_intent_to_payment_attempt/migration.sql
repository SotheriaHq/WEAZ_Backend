ALTER TABLE "PaymentAttempt"
ADD COLUMN "checkoutIntentId" UUID;

ALTER TABLE "PaymentAttempt"
ADD CONSTRAINT "PaymentAttempt_checkoutIntentId_fkey"
FOREIGN KEY ("checkoutIntentId") REFERENCES "CustomOrderCheckoutIntent"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PaymentAttempt_subjectType_checkoutIntentId_idx"
ON "PaymentAttempt"("subjectType", "checkoutIntentId");
