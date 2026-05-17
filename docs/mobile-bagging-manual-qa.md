# Mobile Bagging Manual QA

Native E2E framework audit: `threadly-mobile/package.json` has no Detox, Maestro, Appium, or Expo E2E runner. Phase 14 does not install a native E2E stack.

Execution note for this session: no iOS simulator or Android device/emulator was available through this Codex workspace, so the manual cases below are recorded as `NOT TESTED`. This is a production-readiness blocker until QA runs the same cases on real simulator/device sessions.

| Scenario | Device/simulator | Steps | Expected result | Actual result | Status | Evidence note |
| --- | --- | --- | --- | --- | --- | --- |
| Feed DESIGN Bag It eligible | Not available in this session | Sign in as `e2e.buyer@threadly.test`; open Home/Design feed; find an eligible DESIGN; tap `Bag It`. | App checks `/bag/sources/DESIGN/:id/status`, then opens the backend-directed custom flow, fitting flow, stale confirmation, or My Bag. | Not executed. | NOT TESTED | No native E2E framework and no device/simulator session available. |
| Feed DESIGN missing fittings | Not available in this session | Sign in with buyer missing required measurements; open matching DESIGN; tap `Bag It`. | Fittings sheet opens; no custom bag line is created until required fittings are supplied. | Not executed. | NOT TESTED | Requires device/simulator and seeded DESIGN source. |
| Feed DESIGN stale fittings | Not available in this session | Sign in with buyer whose required measurements are older than stale threshold; open custom-ready DESIGN; tap `Bag It`. | Stale fittings confirmation sheet opens with `Continue with existing fittings` and `Update fittings`. | Not executed. | NOT TESTED | Requires stale fitting profile on native session. |
| Feed DESIGN ready fittings | Not available in this session | Sign in with buyer with fresh required fittings; open custom-ready DESIGN; tap `Bag It`. | Custom bag flow opens without missing/stale fitting block. | Not executed. | NOT TESTED | Requires seeded ready-fittings profile on native session. |
| Product detail standard bagging | Not available in this session | Open standard product detail; tap `Bag It`. | Standard bag mutation succeeds or selector/fittings flow opens according to backend status; My Bag count refreshes. | Not executed. | NOT TESTED | Requires native product detail run. |
| Brand shop product bagging | Not available in this session | Open brand shop; open a product; tap standard `Bag It`; if custom is enabled, tap custom bag action. | Standard and custom actions follow backend eligibility and update My Bag count after mutation. | Not executed. | NOT TESTED | Requires native brand shop run. |
| My Bag bottom island count | Not available in this session | Sign in with at least one standard or custom bag line; observe the bottom island My Bag tab. | Badge uses `/bag/count` `combinedCount`. | Not executed. | NOT TESTED | Code path exists; device evidence not captured. |
| My Bag opens summary | Not available in this session | Tap the My Bag bottom island item. | My Bag summary/sheet opens with standard and custom lines where present. | Not executed. | NOT TESTED | Requires native UI session. |
| Count refresh after standard mutation | Not available in this session | Note My Bag count; add a standard product to the bag. | Count refreshes after the successful standard mutation. | Not executed. | NOT TESTED | Requires native mutation run. |
| Count refresh after custom mutation | Not available in this session | Note My Bag count; add or start a custom bag line. | Count refreshes after the successful custom mutation. | Not executed. | NOT TESTED | Requires native mutation run. |
| Logged-out auth/resume | Not available in this session | Sign out; open public baggable product or DESIGN; tap `Bag It`; complete login. | Auth prompt opens before mutation; after login, pending Bag It resumes when source context is available. | Not executed. | NOT TESTED | Requires native auth session. |

## Validation Commands

- `npm exec tsc -- --noEmit`: PASS.
- `npm run ci:design-system`: PASS.
- `npm run audit:theme`: PASS.
