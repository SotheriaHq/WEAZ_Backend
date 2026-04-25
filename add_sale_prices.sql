-- SQL script to add sale prices to the test collection
-- Run this in your PostgreSQL database

UPDATE "Collection"
SET 
  "saleMinPrice" = 1500,
  "saleMaxPrice" = 3000,
  "saleStartAt" = '2025-01-01T00:00:00.000Z',
  "saleEndAt" = '2025-12-31T23:59:59.999Z'
WHERE 
  id = 'ac2215ce-352c-45eb-9a6f-1bf8b3174832';

-- Verify the update
SELECT 
  id,
  title,
  "minPrice",
  "maxPrice",
  "saleMinPrice",
  "saleMaxPrice",
  "saleStartAt",
  "saleEndAt"
FROM "Collection"
WHERE id = 'ac2215ce-352c-45eb-9a6f-1bf8b3174832';
