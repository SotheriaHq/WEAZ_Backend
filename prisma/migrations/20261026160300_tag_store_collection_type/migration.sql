-- Store collections get their own tag-binding type; COLLECTION remains designs.
-- Added on its own: a new enum value cannot be used in the transaction that adds it.
ALTER TYPE "TagEntityType" ADD VALUE IF NOT EXISTS 'STORE_COLLECTION';
