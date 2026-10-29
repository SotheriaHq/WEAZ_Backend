BEGIN;
LOCK TABLE "StandardOrderRefund", "CustomOrderQueueRefund" IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM "StandardOrderRefund" r JOIN "PaymentAttempt" p ON p.id=r."paymentAttemptId"
    WHERE r."providerRefundId" IS NOT NULL AND upper(r.provider)<>upper(p.provider)) THEN
    RAISE EXCEPTION 'REFUND_CAPTURE_PROVIDER_MISMATCH' USING ERRCODE='23514';
  END IF;
END $$;
CREATE TABLE "ProviderRefundIdentity" (
  provider text NOT NULL,
  "providerRefundId" text NOT NULL,
  "paymentAttemptId" uuid NOT NULL REFERENCES "PaymentAttempt"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "standardRefundId" uuid REFERENCES "StandardOrderRefund"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "customRefundId" uuid REFERENCES "CustomOrderQueueRefund"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "createdAt" timestamp(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "ProviderRefundIdentity_pkey" PRIMARY KEY(provider,"providerRefundId"),
  CONSTRAINT "ProviderRefundIdentity_one_target" CHECK (num_nonnulls("standardRefundId","customRefundId")=1),
  CONSTRAINT "ProviderRefundIdentity_provider" CHECK (provider=upper(provider) AND length(provider)>0)
);
CREATE INDEX "ProviderRefundIdentity_paymentAttemptId_idx" ON "ProviderRefundIdentity"("paymentAttemptId");
CREATE INDEX "ProviderRefundIdentity_standardRefundId_idx" ON "ProviderRefundIdentity"("standardRefundId");
CREATE INDEX "ProviderRefundIdentity_customRefundId_idx" ON "ProviderRefundIdentity"("customRefundId");

-- Conflicts abort; never choose between two claimants or discard identity history.
INSERT INTO "ProviderRefundIdentity"(provider,"providerRefundId","paymentAttemptId","standardRefundId","customRefundId")
SELECT upper(p.provider),r."providerRefundId",r."paymentAttemptId",r.id,NULL::uuid
FROM "StandardOrderRefund" r JOIN "PaymentAttempt" p ON p.id=r."paymentAttemptId" WHERE r."providerRefundId" IS NOT NULL
UNION ALL
SELECT upper(p.provider),r."providerRefundId",r."paymentAttemptId",NULL::uuid,r.id
FROM "CustomOrderQueueRefund" r JOIN "PaymentAttempt" p ON p.id=r."paymentAttemptId" WHERE r."providerRefundId" IS NOT NULL;

CREATE FUNCTION wiez_register_provider_refund_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gateway text; standard_id uuid; custom_id uuid;
BEGIN
  IF NEW."providerRefundId" IS NULL THEN RETURN NEW; END IF;
  SELECT upper(provider) INTO gateway FROM "PaymentAttempt" WHERE id=NEW."paymentAttemptId";
  IF TG_TABLE_NAME='StandardOrderRefund' THEN
    standard_id:=NEW.id;
    IF upper(NEW.provider)<>gateway THEN RAISE EXCEPTION 'REFUND_CAPTURE_PROVIDER_MISMATCH' USING ERRCODE='23514'; END IF;
  ELSE custom_id:=NEW.id; END IF;
  INSERT INTO "ProviderRefundIdentity"(provider,"providerRefundId","paymentAttemptId","standardRefundId","customRefundId")
  VALUES(gateway,NEW."providerRefundId",NEW."paymentAttemptId",standard_id,custom_id)
  ON CONFLICT(provider,"providerRefundId") DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM "ProviderRefundIdentity" i WHERE i.provider=gateway AND i."providerRefundId"=NEW."providerRefundId"
    AND i."paymentAttemptId"=NEW."paymentAttemptId" AND i."standardRefundId" IS NOT DISTINCT FROM standard_id
    AND i."customRefundId" IS NOT DISTINCT FROM custom_id) THEN
    RAISE EXCEPTION 'REFUND_PROVIDER_ID_ALREADY_LINKED' USING ERRCODE='23505',CONSTRAINT='ProviderRefundIdentity_pkey';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "StandardOrderRefund_provider_identity" AFTER INSERT OR UPDATE OF "providerRefundId",provider,"paymentAttemptId"
  ON "StandardOrderRefund" FOR EACH ROW EXECUTE FUNCTION wiez_register_provider_refund_identity();
CREATE TRIGGER "CustomOrderQueueRefund_provider_identity" AFTER INSERT OR UPDATE OF "providerRefundId","paymentAttemptId"
  ON "CustomOrderQueueRefund" FOR EACH ROW EXECUTE FUNCTION wiez_register_provider_refund_identity();

CREATE FUNCTION wiez_refund_identity_is_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'REFUND_PROVIDER_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
END $$;
CREATE TRIGGER "ProviderRefundIdentity_immutable" BEFORE UPDATE OR DELETE ON "ProviderRefundIdentity"
  FOR EACH ROW EXECUTE FUNCTION wiez_refund_identity_is_immutable();

CREATE FUNCTION wiez_refund_settlement_requires_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='SETTLED' AND OLD.status<>'SETTLED' AND
    (OLD."leaseToken" IS NULL OR OLD."lockedAt" IS NULL OR OLD.status NOT IN ('SUBMITTING','PROCESSING') OR
     OLD."lockedAt"<=clock_timestamp() AT TIME ZONE 'UTC'-INTERVAL '10 minutes') THEN
    RAISE EXCEPTION 'REFUND_SETTLEMENT_OWNER_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "StandardOrderRefund_settlement_owner" BEFORE UPDATE OF status
  ON "StandardOrderRefund" FOR EACH ROW EXECUTE FUNCTION wiez_refund_settlement_requires_owner();
CREATE TRIGGER "CustomOrderQueueRefund_settlement_owner" BEFORE UPDATE OF status
  ON "CustomOrderQueueRefund" FOR EACH ROW EXECUTE FUNCTION wiez_refund_settlement_requires_owner();
COMMIT;
