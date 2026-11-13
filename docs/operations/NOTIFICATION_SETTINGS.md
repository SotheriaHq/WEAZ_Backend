# Notification settings and delivery

The settings overview opens a focused screen for each topic. Native includes this phone’s permission/registration status; web and Studio manage the same account preferences and explain that phone permission is managed in the app. Browser message alerts remain in Messages.

## Visible controls

Push delivery is enabled by the server default for new accounts. Turning it off hides Alerts, Quiet hours and native This phone. Topic preferences still govern the WIEZ inbox; message read/delivery receipts remain available as privacy choices. Turning off Comments or Tags hides their dependent controls without changing the saved values.

All canonical security, social, comments, tags, collections, brand, orders, reviews, fitting and messaging preferences remain accessible. Security alert preferences do not disable critical security emails. Email preferences have a separate API and screen.

Quiet-hour fields appear only while both push and quiet hours are enabled. Existing server delivery uses UTC; the screens label this explicitly. Both times are required; equal times pause non-urgent push all day; a start later than the end crosses midnight. A blank time is saved as null. This release does not introduce local-time conversion or queue paused alerts for later delivery.

## Safe saves

Each QueryClient has one active preference controller identified by account, session identity and monotonic sign-in generation. JWT refresh within the same session retains its generation. Sign-out or an account/session transition retires queued actions, including A→B→A. Requests use the ordinary HTTP session guards, refresh and MFA enforcement; they do not use a previous-account bearer-token override.

Edits appear immediately as a temporary overlay above confirmed server data. Writes run serially per session. Earlier responses cannot undo later pending edits. A failure removes only that edit and offers Retry/Dismiss. Retry is bound to the original session. Failed or queued changes are not replayed after sign-out or an app restart. A pending older read is cancelled before the saved response updates the cache.

PostgreSQL locks the account row inside one transaction, normalizes existing effective preferences under that lock, then saves the validated merge. This uses two bounded statements and preserves older implicit sibling preferences as well as explicit values. Concurrent devices can change separate sections or different fields in the same section without replacing one another’s work. The fitting-chart preference writer updates only its JSON subtree in an atomic statement against the same row, so it cannot replace notification choices. If two devices change the same field, the last committed update wins. No schema migration or data reset is required.

## Verification and release

- Web: npm run test:notification-settings (actual DOM navigation/visibility and real QueryClient save races).
- Native: npm run test:notification-settings-contract; npm run test:push-registration-recovery-contract; npm run test:settings-sections; npm run check:borders; the design-system audit against the intended checkout.
- Optional paired client check: set WIEZ_WEB_SECURITY_ROOT to the matching web checkout before the native settings contract. It compares shared behavior and executes both stores.
- Backend: notification service/controller unit tests and npm run test:notification-settings-postgres. The latter refuses non-loopback connections, creates a uniquely named disposable database, forces real row-lock contention, then removes only that database. Application data is not reset.
- CI includes the notification tests before release. Backend and client changes are backward compatible; deploy verified backend first, then clients. Do not release until both independent reviews and required CI gates pass.

Manual acceptance after release: open each section, navigate Back, disable/re-enable push and quiet hours, change two different switches quickly, retry after a network failure, and switch accounts while a save is pending. Confirm no prior account’s failure banner or queued change appears in the next account. On a real signed Android build, deny permission, enable it in system Settings, return to WIEZ and confirm registration/delivery. iOS hardware acceptance remains separate. No physical-device delivery is claimed by local browser or module tests.

## References

- [PostgreSQL Read Committed behavior](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED)
- [TanStack Query cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation)
