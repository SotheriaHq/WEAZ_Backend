DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.tables
		WHERE table_schema = 'public'
		  AND table_name = 'ProductReview'
	) THEN
		EXECUTE '
			CREATE UNIQUE INDEX IF NOT EXISTS "ProductReview_active_userId_productId_key"
			ON "ProductReview"("userId", "productId")
			WHERE "deletedAt" IS NULL AND "status" <> ''DELETED_BY_USER''
		';
	END IF;
END $$;