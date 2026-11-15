BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TYPE "ProductFirstPublicationSource" AS ENUM ('OBSERVED', 'SCHEDULED', 'INFERRED');

ALTER TABLE "Product"
  ADD COLUMN "firstPublishedAt" TIMESTAMPTZ(3),
  ADD COLUMN "firstPublicationSource" "ProductFirstPublicationSource",
  ADD COLUMN "lastRelistedAt" TIMESTAMPTZ(3),
  ADD CONSTRAINT "Product_first_publication_provenance_check"
    CHECK (("firstPublishedAt" IS NULL) = ("firstPublicationSource" IS NULL)) NOT VALID,
  ADD CONSTRAINT "Product_first_publication_finite_check" CHECK (
    ("firstPublishedAt" IS NULL OR isfinite("firstPublishedAt"))
    AND ("lastRelistedAt" IS NULL OR isfinite("lastRelistedAt"))) NOT VALID,
  ADD CONSTRAINT "Product_publication_source_dates_finite_check" CHECK (
    isfinite("createdAt") AND ("publishAt" IS NULL OR isfinite("publishAt"))) NOT VALID;

-- A future active publication follows its schedule until that date becomes
-- effective. Once effective, its first date survives edits and relisting.
CREATE FUNCTION wiez_product_publication_dates() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- A writer can wait on the row lock across the scheduled publication time.
  -- Reads still see the old due row while it waits; statement/transaction start
  -- would incorrectly let that writer erase an already-effective first date.
  captured_at TIMESTAMPTZ := date_trunc('milliseconds', clock_timestamp());
  new_schedule TIMESTAMPTZ := NEW."publishAt" AT TIME ZONE 'UTC';
  new_due BOOLEAN;
  new_scheduled BOOLEAN;
  old_due BOOLEAN := FALSE;
  old_final BOOLEAN := FALSE;
  old_schedule TIMESTAMPTZ;
  inferred_first TIMESTAMPTZ;
BEGIN
  new_due := NEW."publicationStatus" = 'PUBLISHED' AND NEW."isActive"
    AND NEW."deletedAt" IS NULL AND NEW."archivedAt" IS NULL
    AND (new_schedule IS NULL OR new_schedule <= captured_at);
  new_scheduled := NEW."publicationStatus" = 'PUBLISHED' AND NEW."isActive"
    AND NEW."deletedAt" IS NULL AND NEW."archivedAt" IS NULL
    AND new_schedule > captured_at;

  IF TG_OP = 'UPDATE' THEN
    old_schedule := OLD."publishAt" AT TIME ZONE 'UTC';
    old_due := OLD."publicationStatus" = 'PUBLISHED' AND OLD."isActive"
      AND OLD."deletedAt" IS NULL AND OLD."archivedAt" IS NULL
      AND (old_schedule IS NULL OR old_schedule <= captured_at);
    old_final := OLD."firstPublishedAt" IS NOT NULL AND
      (OLD."firstPublicationSource" <> 'SCHEDULED'
       OR OLD."firstPublishedAt" <= captured_at);
    NEW."lastRelistedAt" := OLD."lastRelistedAt";

    IF old_final THEN
      NEW."firstPublishedAt" := OLD."firstPublishedAt";
      NEW."firstPublicationSource" := OLD."firstPublicationSource";
      -- Account for a later scheduled relist that became due without a write.
      IF old_due AND old_schedule > OLD."firstPublishedAt"
        AND (NEW."lastRelistedAt" IS NULL OR NEW."lastRelistedAt" < old_schedule) THEN
        NEW."lastRelistedAt" := old_schedule;
      END IF;
      IF new_due AND NOT old_due THEN
        NEW."lastRelistedAt" := captured_at;
      END IF;
      RETURN NEW;
    END IF;

    -- The separately audited backfill can record an explicitly inferred date.
    -- Normal create/update DTOs do not expose either provenance field.
    IF OLD."firstPublishedAt" IS NULL
      AND NEW."firstPublicationSource" = 'INFERRED'
      AND NEW."firstPublishedAt" IS NOT NULL
      AND NEW."firstPublishedAt" <= captured_at
      AND NEW."firstPublishedAt" >= (OLD."createdAt" AT TIME ZONE 'UTC')
      AND (old_due OR OLD."publishNotifiedAt" IS NOT NULL) THEN
      RETURN NEW;
    END IF;

    -- A pre-existing public row can be edited between schema expansion and
    -- its bounded backfill. Do not mislabel that edit as a new publication.
    IF OLD."firstPublishedAt" IS NULL AND old_due THEN
      inferred_first := CASE WHEN OLD."publishNotifiedAt" IS NOT NULL THEN
        LEAST(COALESCE(old_schedule, OLD."publishNotifiedAt" AT TIME ZONE 'UTC'),
          OLD."publishNotifiedAt" AT TIME ZONE 'UTC')
        ELSE COALESCE(old_schedule, OLD."createdAt" AT TIME ZONE 'UTC') END;
      NEW."firstPublishedAt" := LEAST(captured_at,
        GREATEST(OLD."createdAt" AT TIME ZONE 'UTC', inferred_first));
      NEW."firstPublicationSource" := 'INFERRED';
      IF old_schedule > NEW."firstPublishedAt" THEN
        NEW."lastRelistedAt" := GREATEST(NEW."lastRelistedAt", old_schedule);
      END IF;
      RETURN NEW;
    END IF;
  ELSE
    NEW."lastRelistedAt" := NULL;
  END IF;

  IF new_due THEN
    NEW."firstPublishedAt" := captured_at;
    NEW."firstPublicationSource" := 'OBSERVED';
  ELSIF new_scheduled THEN
    NEW."firstPublishedAt" := new_schedule;
    NEW."firstPublicationSource" := 'SCHEDULED';
  ELSE
    NEW."firstPublishedAt" := NULL;
    NEW."firstPublicationSource" := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_product_publication_dates
BEFORE INSERT OR UPDATE ON "Product"
FOR EACH ROW EXECUTE FUNCTION wiez_product_publication_dates();

COMMIT;
