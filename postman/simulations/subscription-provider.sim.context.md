# Local payment-provider regression

Run from the backend with Postman CLI1.76 or later:

```powershell
postman simulation run postman/simulations/subscription-provider.sim.yaml --port 4917 --output ndjson
```

The `paystack` member base is `http://127.0.0.1:4917/paystack`.
The local `__stats` endpoint confirms routing if redirected CLI output is buffered.
Fixture control routes, synthetic authorization and transaction IDs exist only in this mock.
Unknown provider routes return501. No actual card/customer credentials are used.

Disposable PostgreSQL harnesses require an existing loopback development database
connection for creating a random test database; they remove only that test database.
Never point them at an external or application database for resetting data.

```powershell
$env:SUBSCRIPTION_PROVIDER_SIM_URL='http://127.0.0.1:4917/paystack'
$env:STANDARD_PAYMENT_PROVIDER_SIM_URL='http://127.0.0.1:4917/paystack'
node scripts/verify-ledger-concurrency.cjs
$env:CUSTOM_PAYMENT_PROVIDER_SIM_URL='http://127.0.0.1:4917/paystack'
node scripts/verify-custom-order-issue-race.cjs
```

25October2026: ledger35cases pass with cleanup, including seven subscription HTTP
scenarios and26standard confirmations. Issue25cases pass with cleanup, including
26custom HTTP confirmations, wrong amount/pending/failed/503, fresh standard/custom
unified finalization and real session/cart lock waits. Harnesses use the actual
payment clients, finance services and database writes. Outbound email/push/socket
handoffs are captured, so this is not live provider or device-delivery acceptance.

The mock initially reused one provider transaction ID; unique database constraints
correctly refused duplicate capture identity. Each synthetic transaction now has a
stable distinct ID. The current payment verification base is injected through a
trusted dependency token; official production defaults remain unchanged.

Stop the simulation when finished. HTTP scenarios are optional environment-driven
checks; their final release-CI wiring and live acceptance remain separate gates.
