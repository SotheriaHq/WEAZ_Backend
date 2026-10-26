# Debt summary and grouped recovery queries

The canonical debt summary and notification recipient now come from one
Brand/debt aggregate JOIN. The database sums current unrecovered debit amounts
minus manual credits, clamps the displayed outstanding value at zero, and returns
count, oldest date and the existing currency indicator. The application no longer
loads every active debt row to produce a summary or separately fetches its owner
for a notice. Public response fields remain unchanged.

Admin payout release already groups allocations by brand and currency before
calling debt recovery. Recovery needs a current oldest-first debt list for each
protected payout command; it does not fetch that list once per allocation.

The actual PostgreSQL fixture runs26 eligible allocations through the real admin
release method: one debt-list read, two debts recovered by15 in total, and a single
219 payout from234 net earnings. Repeating the selected release creates no extra
payout or recovery. A second case verifies one-query summary/notice contexts,
manual-credit netting, missing-brand defaults and correct owner handoff.

These are scoped query checks. The existing recovery code still lacks a currency
filter and dedicated recovery serialization, uses number arithmetic, and announces
outside its enclosing financial commit. Those financial/race issues remain open
release gates. The aggregate retains the current cross-currency display behavior;
it does not establish that mixing currencies is valid. Actual notification
transport and rollback-safe delivery are not verified by the handoff check.
