ALTER TABLE "Brand"
  ADD COLUMN "country" TEXT,
  ADD COLUMN "state" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "businessType" TEXT,
  ADD COLUMN "companyLocation" TEXT,
  ADD COLUMN "socialFacebook" TEXT,
  ADD COLUMN "cacNumber" TEXT,
  ADD COLUMN "tin" TEXT,
  ADD COLUMN "ceoNin" TEXT,
  ADD COLUMN "ceoFirstName" TEXT,
  ADD COLUMN "ceoLastName" TEXT,
  ADD COLUMN "industriNumber" TEXT;

CREATE UNIQUE INDEX "Brand_cacNumber_key" ON "Brand"("cacNumber");
CREATE UNIQUE INDEX "Brand_tin_key" ON "Brand"("tin");
CREATE UNIQUE INDEX "Brand_ceoNin_key" ON "Brand"("ceoNin");
CREATE UNIQUE INDEX "Brand_industriNumber_key" ON "Brand"("industriNumber");
