-- Ledger accounts are identified by (code, currency). Postings in different
-- currencies never share a balance, every entry's account currency equals its
-- transaction's currency, and every transaction balances when its database
-- transaction commits. Existing accounts keep their recorded currency.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "LedgerEntry" entry
    JOIN "LedgerTransaction" txn ON txn.id = entry."transactionId"
    JOIN "LedgerAccount" account ON account.id = entry."accountId"
    WHERE account.currency <> txn.currency
  ) THEN
    RAISE EXCEPTION 'Ledger entries already mix currencies. Reconcile them before applying currency identity.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "LedgerEntry" GROUP BY "transactionId"
    HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END)
      <> SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END)
  ) THEN
    RAISE EXCEPTION 'Unbalanced ledger transactions exist. Reconcile them before applying balance enforcement.';
  END IF;
END $$;

DROP INDEX "LedgerAccount_code_key";
CREATE UNIQUE INDEX "LedgerAccount_code_currency_key" ON "LedgerAccount"("code", "currency");
DROP INDEX "LedgerAccount_entityType_entityId_idx";
CREATE INDEX "LedgerAccount_entityType_entityId_currency_idx" ON "LedgerAccount"("entityType", "entityId", "currency");
ALTER TABLE "LedgerAccount" ALTER COLUMN "currency" DROP DEFAULT;

ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "LedgerTransaction" ADD CONSTRAINT "LedgerTransaction_currency_format"
  CHECK ("currency" ~ '^[A-Z]{3}$' AND "baseCurrency" ~ '^[A-Z]{3}$');
ALTER TABLE "LedgerTransaction" ADD CONSTRAINT "LedgerTransaction_amounts_non_negative"
  CHECK ("totalAmount" >= 0 AND "baseCurrencyAmount" >= 0);
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_amount_positive" CHECK ("amount" > 0);

-- Entries are append-only and posted only to an account of the transaction's currency.
CREATE FUNCTION ledger_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."accountId" IS DISTINCT FROM OLD."accountId" OR
    NEW."transactionId" IS DISTINCT FROM OLD."transactionId" OR
    NEW.direction IS DISTINCT FROM OLD.direction OR
    NEW.amount IS DISTINCT FROM OLD.amount OR
    NEW."balanceAfter" IS DISTINCT FROM OLD."balanceAfter"
  ) THEN
    RAISE EXCEPTION 'LEDGER_ENTRY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "LedgerAccount" account JOIN "LedgerTransaction" txn ON txn.id = NEW."transactionId"
    WHERE account.id = NEW."accountId" AND account.currency = txn.currency
  ) THEN
    RAISE EXCEPTION 'LEDGER_ENTRY_CURRENCY_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "LedgerEntry_guard" BEFORE INSERT OR UPDATE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_guard();

-- Double entry is checked once all of a transaction's lines are written.
CREATE FUNCTION ledger_transaction_balance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN target := OLD."transactionId"; ELSE target := NEW."transactionId"; END IF;
  IF EXISTS (SELECT 1 FROM "LedgerTransaction" WHERE id = target) AND EXISTS (
    SELECT 1 FROM "LedgerEntry" WHERE "transactionId" = target
    HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END)
      <> SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END)
  ) THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED_TRANSACTION' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "LedgerEntry_balanced" AFTER INSERT OR DELETE ON "LedgerEntry"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_transaction_balance_guard();
