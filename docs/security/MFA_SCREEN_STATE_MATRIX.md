# MFA screen and interaction acceptance matrix

Multi-factor authentication (MFA) adds another proof of identity beyond a password. This is a release acceptance checklist, not a declaration that the screens or deployment are complete.

## Product rules

- Start mandatory verification with administrators and finance/security actions.
- Sensitive viewing has a five-minute verification window. Critical changes require a separate one-use approval for the exact request; a viewing window cannot authorize them.
- Show the server-approved action and price before verification. Never silently replace a quote or repeat an uncertain payment.
- Keep the last verified method until a replacement is verified. An unfinished replacement is not a usable method.
- Recovery codes are one-use account-level credentials. Show new codes once; never persist them in query caches, URLs, logs or analytics.
- Total loss of all methods and recovery codes uses support-reviewed recovery with TWO different authorised administrators. Email possession alone must never remove MFA. A submitted request is not approval and must not unlock protected actions.
- Cancel transient prompts when the account/session changes, on explicit cancellation or expiry. A hard refresh must not resurrect a secret or automatically resume a critical change.
- Native Apple passkeys are deferred. Android and supported web browsers remain in scope; iOS retains authenticator/recovery alternatives. No Apple identifiers or entitlements are configured in this tranche.

## Required journeys

| Journey | Required screens, states and interactions | Current acceptance status |
|---|---|---|
| Method overview | Loading; no methods; enrolled methods; remaining recovery-code count; unavailable/offline; retry; stale account cancellation | Web/native implemented, server status validation and local client tests pass; physical acceptance pending |
| First setup | Explain MFA; confirm password; verified-email prerequisite; email delivery pending; code entry; resend/throttled/incorrect/expired; authenticator QR and manual key; six-digit confirmation | Backend locally tested; client acceptance pending |
| Passwordless account | Explain why a password is needed; reach the existing password setup/reset journey; return without bypassing proof | Client integration pending |
| New setup confirmation | Wrong/replayed code; setup expired; server unavailable; successful verification; recovery codes shown once; save acknowledgement | Backend locally tested; client acceptance pending |
| Routine step-up | Exact action summary; choose an enrolled method; authenticator/recovery/passkey entry; busy; wrong/expired/exhausted; cancel; confirmed; continue the original request once | Backend lifecycle tested; signed passkey and client acceptance pending |
| Subscription or money action | Held quote/account ending; explicit approval; quote expiry requires new review; no silent repricing; pending provider outcome | Billing locally tested; MFA screen integration pending |
| Passkey setup/use | Supported/unsupported; method name; prepared options; explicit system prompt; cancellation; duplicate credential; retry confirmation; RP/origin/UV/signature/counter checks; alternative method | Web/Android source and real signed local fixtures pass. Live association, private signing, new APK and device/browser acceptance pending; native Apple deferred |
| Replace lost authenticator | Verify surviving method/recovery code; explain old method stays active; setup new secret; cancel/expiry leaves old method active; atomic successful replacement | Backend locally tested; client acceptance pending |
| Remove a method | Confirm selected method; last-method block with replacement action; password and exact one-use approval; changed/deleted method; success; refresh list | Backend locally tested; client acceptance pending |
| Regenerate recovery codes | Explain old codes stop working; password and exact approval; busy/error; new codes once; save acknowledgement | Backend locally tested; client acceptance pending |
| Total-loss recovery | Explain review; submit limited recovery request; duplicate request; review pending; more information requested; rejected; expired; approved limited re-enrollment; completed; audit/security notices | Backend99-case checkpoint includes concurrent review/self-review/expiry; web/native account-holder + web reviewer interfaces written, web state tests pass; physical acceptance pending |
| Cross-cutting | Keyboard-visible actions; Back closes overlay first; full text/large fonts; screen readers; rotation; light/dark; network loss/retry; refresh; account switch; app resume; WebView child session isolation | Automated and physical acceptance pending |

## Release gate

No mandatory-MFA deployment until every applicable row has evidence for web, native and Studio WebViews, including negative cases. Backend-only tests do not establish screen completeness. Support recovery must have real server state and auditable reviewer authorization; never display a fabricated submitted/approved screen.

## Current local checkpoints

The client screen/security suite passes 87 web checks (12 suites), including seven account-holder recovery states, reviewer authority states, passkey preparation/cancellation/retry, malformed status and unsaved-code close protection. Twelve native runtime/paired-contract checks pass; a deliberate one-sided deadline mutation is detected by the contract. Web/native typechecks, scoped web lint, native borders/design audits and website association generation tests pass at this checkpoint. Backend 99 integration cases pass with disposable database cleanup. These are separate overlapping suites, not a combined unique-test or capacity claim. No physical passkey or deployed-enforcement acceptance is claimed. See the [passkey rollout runbook](../operations/MFA_PASSKEYS.md).
