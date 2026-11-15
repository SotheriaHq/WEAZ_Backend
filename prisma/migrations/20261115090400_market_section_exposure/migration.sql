BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- CreateTable
CREATE TABLE "market_section_exposure" (
    "sectionKey" VARCHAR(80) NOT NULL,
    "productId" UUID NOT NULL,
    "epoch" TIMESTAMPTZ(3) NOT NULL,
    "epochId" UUID,
    "slot" INTEGER NOT NULL,

    CONSTRAINT "market_section_exposure_pkey" PRIMARY KEY ("sectionKey","productId","epoch")
);

-- CreateIndex
CREATE INDEX "market_section_exposure_sectionKey_epoch_idx" ON "market_section_exposure"("sectionKey", "epoch");

-- CreateIndex
CREATE INDEX "market_section_exposure_epoch_sectionKey_productId_idx" ON "market_section_exposure"("epoch", "sectionKey", "productId");

-- AddForeignKey
ALTER TABLE "market_section_exposure" ADD CONSTRAINT "market_section_exposure_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_section_exposure" ADD CONSTRAINT "market_section_exposure_epochId_fkey" FOREIGN KEY ("epochId") REFERENCES "market_feature_epochs"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE market_section_exposure ADD CONSTRAINT market_section_exposure_shape_check CHECK(
  length(trim("sectionKey"))>0 AND slot>=0 AND slot<12
  AND CASE WHEN isfinite(epoch) THEN mod(extract(epoch FROM epoch),21600)=0 ELSE false END);


CREATE FUNCTION wiez_section_exposure_epoch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."epochId" IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM market_feature_epochs WHERE id=NEW."epochId" AND status='READY') THEN
    RAISE EXCEPTION 'Section placement may reference only a published feature snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_section_exposure_epoch_guard BEFORE INSERT OR UPDATE OF "epochId"
  ON market_section_exposure FOR EACH ROW EXECUTE FUNCTION wiez_section_exposure_epoch_guard();

COMMIT;
