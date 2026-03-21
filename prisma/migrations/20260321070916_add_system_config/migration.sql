-- CreateTable
CREATE TABLE "system_config" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "system_config_pkey" PRIMARY KEY ("key")
);

-- AddForeignKey
ALTER TABLE "system_config" ADD CONSTRAINT "system_config_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
