-- Make the order<->thread link's unique indexes plain, so Prisma's `upsert` works.
--
-- `20260424121000_add_unified_message_conversations` created both indexes PARTIAL
-- (`... WHERE "customOrderId" IS NOT NULL`), while `schema.prisma` declares them as
-- plain `@@unique([customOrderId])` / `@@unique([orderId])`. Prisma trusts the schema
-- and compiles
--     messageThreadOrderLink.upsert({ where: { customOrderId }, ... })
-- into `INSERT ... ON CONFLICT ("customOrderId") DO UPDATE`. Postgres will not infer a
-- partial index as an ON CONFLICT target, so every such call died with
--     there is no unique or exclusion constraint matching the ON CONFLICT specification
-- and returned HTTP 500.
--
-- That is the whole of the "Could not open the conversation for this order" failure:
-- linking the order into the buyer<->brand thread is the last step of opening it, so
-- the thread was found (and even created) and then the request threw on the link.
-- The read-only sibling endpoint never upserts, which is why the button could say
-- "Go to conversation" and still fail when pressed.
--
-- Widening the indexes costs no uniqueness: in Postgres a plain unique index on a
-- nullable column already allows unlimited NULL rows, so the `IS NOT NULL` predicate
-- only ever removed the ON CONFLICT target. Existing rows cannot violate the wider
-- index either -- the partial one already enforced uniqueness across every non-null
-- value, and NULLs never conflict.

DROP INDEX IF EXISTS "MessageThreadOrderLink_orderId_key";
CREATE UNIQUE INDEX "MessageThreadOrderLink_orderId_key"
  ON "MessageThreadOrderLink"("orderId");

DROP INDEX IF EXISTS "MessageThreadOrderLink_customOrderId_key";
CREATE UNIQUE INDEX "MessageThreadOrderLink_customOrderId_key"
  ON "MessageThreadOrderLink"("customOrderId");
