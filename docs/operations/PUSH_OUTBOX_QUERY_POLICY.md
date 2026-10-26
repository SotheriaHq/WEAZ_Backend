# Push outbox query policy

The pending-push sweep selects at most100 rows and processes ten at a time.
Unread badges are grouped by recipient once for each group of ten, using the
existing recipient/read-state index. Duplicate recipients share that group read;
no unread notifications produce badge zero. Each group refreshes the snapshot.
If this optional lookup fails, delivery continues without a badge.

Badges describe unread state at the group query time. Reads or new notifications
after that query can change the true count before the phone displays a message.
The badge is a display value; it does not authorize or select delivery tokens.

Each successfully claimed attempt still loads the current active Expo tokens for
its own recipient immediately before composing delivery entries. Token reads are
not cached across the sweep. Lost claims perform no token lookup. Invalid tokens
are disabled through the existing policy, and inactive tokens are excluded.

This query change preserves payloads, per-device ticket mapping, retry behavior
and receipt persistence. It does not repair the separate existing worker claim,
lease-recovery or completion-fencing issues. Those remain release blockers for
the race audit. Permission recovery and conditional settings UI remain separate
native/client work; they were not changed here.

## Verification

The disposable PostgreSQL fixture processes26 attempts with one due scan, three
badge aggregates and26 fresh token guards, instead of26 badge counts. It verifies
zero and nonzero unread counts, read-row exclusion, recipient isolation, inactive
and syntactically invalid tokens, and no transport access for those tokens.
Focused tests cover failed badge reads, zero/oversized batches and lost claims.

The optional HTTP run uses the installed real Expo SDK and a local Postman
simulator built from the [official Expo send/ticket contract](https://docs.expo.dev/push-notifications/sending-notifications/).
The owning-mock search was unavailable because the CLI was signed out. The fixture
sends only synthetic tokens and payloads. Three messages over two HTTP requests
preserve badges0/1 and payload fields, and persist three pending receipt rows.
The simulator log confirms the send requests. A ticket is acceptance by the
service; it is not proof of device delivery. No Expo/FCM/APNs delivery was tested.

Run the simulator in one terminal:

```powershell
postman simulation run postman/simulations/push-provider.sim.yaml --port 4906 --output ndjson
```

In another terminal, with a loopback PostgreSQL connection configured:

```powershell
$env:PUSH_SIMULATION_URL='http://127.0.0.1:4906/expo'
node scripts/verify-file-deletion-postgres.cjs
```

That fixture applies the complete migration chain to a new random disposable
database, exercises the real services, then drops that disposable database. It
does not reset the configured application database. Without the simulation URL,
CI runs the database/no-transport checks only; the optional wire check is not
silently represented as a CI run. Local fixture credentials are not sent to the
simulator; the SDK access token is cleared in this test process.

The same backend serves native iOS/Android, desktop, tablet and browser-mobile
notification records. No client layout or permission UI changed in this pass.
