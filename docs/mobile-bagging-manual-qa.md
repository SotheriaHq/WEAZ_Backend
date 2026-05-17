# Mobile Bagging Manual QA

Native E2E framework audit: `threadly-mobile/package.json` has no Detox, Maestro, Appium, or Expo native E2E runner. Phase 15 does not install a native E2E stack.

Execution environment for this session:

- Android: `adb` is not on PATH, `C:\Users\UTL_ADMIN\AppData\Local\Android\Sdk\platform-tools\adb.exe` does not exist, and `C:\Users\UTL_ADMIN\AppData\Local\Android\Sdk\emulator\emulator.exe` does not exist.
- iOS: `xcrun` is unavailable in this Windows workspace.

Manual QA therefore remains `NOT TESTED` in this session. This is a production-readiness blocker until QA runs the same matrix on a real Android device/emulator and an iOS simulator/device where available.

| Scenario | Device/simulator | Steps | Expected result | Actual result | Status | Evidence note |
| --- | --- | --- | --- | --- | --- | --- |
| Market product opens immersive viewer | Not available | Sign in as buyer; open Market; tap a product card. | Full-screen media-first commerce viewer opens. | Not executed. | NOT TESTED | No Android/iOS runtime available in workspace. |
| Back button returns to Market | Not available | From the product viewer, tap top-left back arrow. | User returns to previous Market context. | Not executed. | NOT TESTED | Requires native runtime. |
| Product media swipes | Not available | Open product with multiple images; swipe horizontally. | Media pages swipe and count updates. | Not executed. | NOT TESTED | Requires seeded product with media. |
| Metadata sheet expands/collapses | Not available | Open viewer; tap sheet handle/guidance. | Expanded sheet collapses; collapsed sheet reveals more media and can expand again. | Not executed. | NOT TESTED | Requires native runtime. |
| Floating Bag It remains accessible | Not available | Collapse metadata sheet; observe/tap Bag It action. | Bag It remains visible and usable. | Not executed. | NOT TESTED | Requires native runtime. |
| Wishlist/save works | Not available | Tap Save, then tap again to unsave. | Saved state toggles through wishlist/saved API with loading protection. | Not executed. | NOT TESTED | Requires authenticated native runtime. |
| Share works | Not available | Tap top-right share. | Native share sheet opens; cancel closes without error. | Not executed. | NOT TESTED | Requires device/simulator share sheet. |
| Message brand works | Not available | Tap Message on an item with brand id. | Brand message route opens or auth prompt appears if logged out. | Not executed. | NOT TESTED | Requires messaging-capable native session. |
| Standard product Bag It works | Not available | Open standard seeded product; tap Bag It. | Backend eligibility is checked and standard add succeeds or opens required selector. | Not executed. | NOT TESTED | Requires seeded product/user. |
| Product requiring size/color opens selector | Not available | Open seeded variant product; tap Bag It. | ProductBagSelectorSheet opens and blocks incomplete add. | Not executed. | NOT TESTED | Requires seeded variant product. |
| Product requiring fittings opens fitting sheet | Not available | Open seeded fitting product; tap Bag It. | Fittings sheet opens; no bag line is created until required fittings are supplied. | Not executed. | NOT TESTED | Requires seeded fitting product and buyer. |
| Custom product opens custom flow | Not available | Open seeded custom product; tap Bag It. | Custom bag flow opens according to backend defaultAction. | Not executed. | NOT TESTED | Requires seeded custom product. |
| Stale fittings opens stale confirmation | Not available | Open seeded stale-fitting source; tap Bag It. | Stale confirmation sheet opens with continue/update actions. | Not executed. | NOT TESTED | Requires stale buyer measurements. |
| Design feed Bag It still works | Not available | Open Home/Design feed; tap eligible DESIGN Bag It. | Existing feed Bag It flow still uses `/bag/sources/DESIGN/:id/status`. | Not executed. | NOT TESTED | Requires native feed session. |
| Market design Bag It works where supported | Not available | Open Market design viewer; tap Bag It. | Viewer checks source eligibility and opens backend-directed custom flow. | Not executed. | NOT TESTED | Requires seeded eligible DESIGN. |
| My Bag count updates | Not available | Add standard or custom line; observe My Bag island count. | Count uses `/bag/count` combinedCount and refreshes after mutation. | Not executed. | NOT TESTED | Requires mutation-capable native runtime. |
| Logged-out Bag It opens auth prompt/resume | Not available | Sign out; open public baggable item; tap Bag It; sign in. | Auth prompt opens and pending Bag It resumes through BagFlowProvider. | Not executed. | NOT TESTED | Requires native auth run. |
| Out-of-stock product disables standard Bag It | Not available | Open seeded out-of-stock non-custom product. | Bag It CTA is disabled with backend disabled reason. | Not executed. | NOT TESTED | Requires out-of-stock seeded product. |
| Own-brand action is blocked | Not available | Sign in as brand owner; open own product/design viewer; tap Bag It or Message. | Own-brand bag/message actions are blocked with explanation. | Not executed. | NOT TESTED | Requires brand-owner native session. |

## Validation Commands

- `npm exec tsc -- --noEmit`: PASS in preliminary Phase 15 check.
- `npm run ci:design-system`: PASS.
- `npm run audit:theme`: PASS.
