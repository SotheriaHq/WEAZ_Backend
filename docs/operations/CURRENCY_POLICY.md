# Currency policy

Three currencies, never confused with each other. Code: `src/payment/currency-policy.ts`,
`src/payment/fx-rate.service.ts`, `src/payment/fx-market-rates.ts`.

| Currency | What it is | Today |
| --- | --- | --- |
| Settlement | What WIEZ accounts in: brand earnings, commissions, escrow, debt, payouts | NGN |
| Charge | What the gateway collects from the shopper | NGN (`CHARGE_CURRENCIES`) |
| Display | What a shopper reads as an estimate | Any currency the FX table covers |

## Rules

- **Catalogue prices are set in a charge currency.** Product create and update refuse any
  other currency (`CURRENCY_NOT_SUPPORTED_FOR_PRICES`). Brands are created in NGN.
- **Checkout never changes currency and never charges what it cannot collect.** Unified
  checkout requires one currency and refuses a non-chargeable basket
  (`CHECKOUT_CURRENCY_NOT_CHARGEABLE`) before it takes a rate snapshot or reserves stock.
- **NGN settlement uses the rate recorded when the customer paid.** Initialization stores an
  `ExchangeRateSnapshot` (parity for NGN) on the `PaymentAttempt`, with `settlementAmount`.
  Verification and finance sync reuse that snapshot (`resolveSettlement`); a missing or
  mismatched snapshot is refused, never guessed. Successful payments are never repriced.
- **Multi-order captures** split the NGN settlement by each order's share of the charged
  amount (`StandardOrderFinanceSyncService.syncCapture`), rounded half-up to kobo.
- **Refunds go back in the charged currency and amount** (`StandardOrderRefund.amount` /
  `currency`). The NGN accounting reversal uses the same original snapshot
  (`StandardOrderEscrowService.settleRefund`). Shopper messages show the charged figures.
- **Never add amounts in different currencies.** Ledger accounts are keyed by
  `(code, currency)`; posting across currencies is refused by the database.
- **Display is an estimate.** `GET /payment/fx/display?country=&currency=` returns NGN-based
  rates, the suggested display currency, `chargeCurrency`, `isStale` and the source date.
  Clients show the estimate next to the NGN price and state the NGN charge at checkout.

## Display currency selection

1. The person's explicit choice (stored on their device).
2. Otherwise their country, from the Cloudflare edge country on the web
   (`functions/api/location.ts`, not stored) or the same hint in the app. A country with one
   currency suggests it; a country with several asks the person instead of guessing.
3. Otherwise NGN.

No GPS or location permission is used. The backend receives at most a country code in the
query string and stores nothing.

## Rates source

Frankfurter v2 (`https://api.frankfurter.dev/v2/rates?base=USD`): free, no key, daily
central-bank reference rates; NGN is covered (checked 2026-10-27: 1 USD = 1,361.2 NGN).
USD observations are used and crossed, so NGN rates are not inverted from a rounded value.

- One table per process, refreshed hourly, single-flight, 5 s timeout, 30 s backoff after a
  failure. Observations older than 7 days are ignored.
- Display may use a table up to 72 h old, marked `isStale`. Payment snapshots never use a
  stale table: if fresh rates are unavailable, a non-NGN quote fails with
  `FX_RATES_TEMPORARILY_UNAVAILABLE`. NGN payments need no rate.
- Override the source with `FX_RATE_API_URL` (HTTPS, or loopback HTTP for fixtures).

## Widening the charge currencies

Paystack's API lists GHS, KES, NGN, USD and ZAR for refunds and charges, but each needs the
merchant account enabled for it. Before adding one to `CHARGE_CURRENCIES`: enable it on the
Paystack account, widen `initPaystack` (it accepts NGN only), test with test keys, and check
settlement and payouts for that currency.

## Paystack refunds

- Create: `POST /refund` with `transaction` (reference), `amount` in the currency's subunit,
  `currency`, `merchant_note`.
- List: only `page`, `perPage`, `from`, `to` are documented (PaystackOSS/openapi
  `paths/refund.yaml`); there is no transaction filter. After an uncertain submission,
  `RefundProviderClient.findByNote` pages from the refund row's creation (minus 10 minutes),
  at most 10 pages of 100, and matches the note and the capture. A failed page or too many
  pages is "unknown" and goes to a person; a refund is never resubmitted on a guess.

## Location lists

`GET /locations/countries` (bundled CLDR list), `/locations/states?country=`,
`/locations/cities?country=&state=` (fetched server-side from countriesnow, cached 24 h,
5 s timeout, failures cached 5 min and answered as an empty list). Browsers and the app no
longer call third-party location services.
