BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "Product"
  ADD COLUMN "effectivePrice" NUMERIC(10,2),
  ADD COLUMN "effectivePriceComputedAt" TIMESTAMPTZ(3),
  ADD COLUMN "effectivePriceValidUntil" TIMESTAMPTZ(3),
  ADD COLUMN "priceChangeXid" xid8,
  ADD CONSTRAINT "Product_base_price_finite_check"
    CHECK (price >= 0 AND price < 'Infinity'::numeric) NOT VALID,
  ADD CONSTRAINT "Product_sale_price_finite_check"
    CHECK ("salePrice" IS NULL OR
      ("salePrice" >= 0 AND "salePrice" < 'Infinity'::numeric)) NOT VALID,
  ADD CONSTRAINT "Product_sale_dates_finite_check"
    CHECK (("saleStartAt" IS NULL OR isfinite("saleStartAt"))
      AND ("saleEndAt" IS NULL OR isfinite("saleEndAt"))) NOT VALID;

-- No wall clock is hidden in this immutable expression: every caller supplies
-- one captured instant. Existing sale columns store UTC TIMESTAMP values.
CREATE FUNCTION wiez_product_effective_price(
  base_price numeric, sale_price numeric,
  sale_start timestamp, sale_end timestamp, captured_at timestamptz
) RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN base_price >= 0 AND base_price < 'Infinity'::numeric
  THEN CASE WHEN sale_price > 0 AND sale_price < base_price
    AND (sale_start IS NULL OR isfinite(sale_start))
    AND (sale_end IS NULL OR isfinite(sale_end))
    AND (sale_start IS NULL OR sale_start <= (captured_at AT TIME ZONE 'UTC'))
    AND (sale_end IS NULL OR sale_end >= (captured_at AT TIME ZONE 'UTC'))
    AND (sale_start IS NULL OR sale_end IS NULL OR sale_start <= sale_end)
  THEN sale_price ELSE base_price END ELSE NULL END;
$$;

CREATE FUNCTION wiez_product_price_boundary(
  base_price numeric, sale_price numeric,
  sale_start timestamp, sale_end timestamp, captured_at timestamptz
) RETURNS timestamptz LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN base_price >= 0 AND base_price < 'Infinity'::numeric
    AND sale_price > 0 AND sale_price < base_price
    AND (sale_start IS NULL OR isfinite(sale_start))
    AND (sale_end IS NULL OR isfinite(sale_end))
    AND (sale_start IS NULL OR sale_end IS NULL OR sale_start <= sale_end)
  THEN CASE
    WHEN sale_start > (captured_at AT TIME ZONE 'UTC')
      THEN sale_start AT TIME ZONE 'UTC'
    WHEN sale_end >= (captured_at AT TIME ZONE 'UTC')
      THEN (sale_end AT TIME ZONE 'UTC') + interval '1 millisecond'
    ELSE NULL END
  ELSE NULL END;
$$;

CREATE FUNCTION wiez_product_price_cache() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  captured_at TIMESTAMPTZ := date_trunc('milliseconds', statement_timestamp());
  price_changed BOOLEAN := TRUE;
  refresh_cache BOOLEAN := TRUE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    price_changed := ROW(NEW.price, NEW."salePrice", NEW."saleStartAt",
        NEW."saleEndAt", NEW.currency)
      IS DISTINCT FROM ROW(OLD.price, OLD."salePrice", OLD."saleStartAt",
        OLD."saleEndAt", OLD.currency);
    refresh_cache := price_changed OR OLD."effectivePriceComputedAt" IS NULL
      OR (OLD."effectivePriceValidUntil" IS NOT NULL
        AND OLD."effectivePriceValidUntil" <= captured_at)
      OR ROW(NEW."effectivePrice", NEW."effectivePriceComputedAt",
        NEW."effectivePriceValidUntil") IS DISTINCT FROM
        ROW(OLD."effectivePrice", OLD."effectivePriceComputedAt",
          OLD."effectivePriceValidUntil");
    NEW."priceChangeXid" := OLD."priceChangeXid";
  END IF;
  IF price_changed OR NEW."priceChangeXid" IS NULL THEN
    -- Top-level xid8 also works for writes made inside savepoints. There is
    -- no single catalogue revision row that serializes independent writers.
    NEW."priceChangeXid" := pg_current_xact_id();
  END IF;
  IF refresh_cache THEN
    NEW."effectivePrice" := wiez_product_effective_price(NEW.price,
      NEW."salePrice", NEW."saleStartAt", NEW."saleEndAt", captured_at);
    NEW."effectivePriceComputedAt" := captured_at;
    NEW."effectivePriceValidUntil" := wiez_product_price_boundary(NEW.price,
      NEW."salePrice", NEW."saleStartAt", NEW."saleEndAt", captured_at);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_product_price_cache
BEFORE INSERT OR UPDATE ON "Product"
FOR EACH ROW EXECUTE FUNCTION wiez_product_price_cache();

-- Old rows are repaired in bounded batches before this constraint is validated.
-- The catalogue price reader must not enable its indexed merge beforehand.
ALTER TABLE "Product" ADD CONSTRAINT "Product_market_price_cache_ready_check"
  CHECK ("effectivePrice" IS NOT NULL AND "effectivePrice" >= 0
    AND "effectivePrice" < 'Infinity'::numeric
    AND "effectivePriceComputedAt" IS NOT NULL AND isfinite("effectivePriceComputedAt")
    AND "priceChangeXid" IS NOT NULL
    AND ("effectivePriceValidUntil" IS NULL OR isfinite("effectivePriceValidUntil"))) NOT VALID;

COMMIT;
