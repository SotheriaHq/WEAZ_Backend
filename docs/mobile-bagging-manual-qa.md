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

## Phase 16C&D Collection Manual QA Matrix

These rows were added after collection bagging and the native collection commerce/gallery viewer implementation. They intentionally remain `NOT TESTED` because this phase did not execute Android/iOS runtime QA.

| Scenario | Device/simulator | Steps | Expected result | Actual result | Status | Evidence note |
| --- | --- | --- | --- | --- | --- | --- |
| Market Latest Collections section loads | Not available | Sign in as buyer; open Market; wait for content. | Latest Collections renders seeded/public store collections with stable loading/empty/error behavior. | Not executed. | NOT TESTED | Requires native runtime. |
| Collection card opens Collection Commerce Viewer | Not available | Tap a collection card from Market. | `/collection-viewer` opens with the tapped collection. | Not executed. | NOT TESTED | Requires native runtime. |
| Collection Viewer shows products | Not available | Open all-eligible seeded collection. | Product list/grid shows all linked products. | Not executed. | NOT TESTED | Requires seeded backend and native runtime. |
| Collection Viewer shows metadata | Not available | Open collection viewer. | Title, brand, description, product count, price range, and availability summary render. | Not executed. | NOT TESTED | Requires native runtime. |
| Bag All succeeds for all-eligible collection | Not available | Open all-eligible seeded collection; tap Bag All. | Backend adds eligible products and shows added/skipped/blocked summary. | Not executed. | NOT TESTED | Requires authenticated native runtime. |
| Bag All blocks mixed collection with clear reasons | Not available | Open mixed seeded collection; tap Bag All. | Blocker panel shows size/color, fittings, stale, stock, and already-in-bag states without silent invalid adds. | Not executed. | NOT TESTED | Requires seeded mixed collection. |
| Bag Selected succeeds for eligible selected products | Not available | Select only eligible products; tap Bag Selected. | Selected products are added and My Bag count refreshes. | Not executed. | NOT TESTED | Requires mutation-capable native runtime. |
| Bag Selected blocks unresolved selected products | Not available | Select a product requiring unresolved size/color/fittings; tap Bag Selected. | Backend returns blocked rows and no invalid selected product is added. | Not executed. | NOT TESTED | Requires seeded mixed collection. |
| Individual product Bag It from collection works | Not available | Tap Bag It on one eligible product inside collection viewer. | Existing product bag flow runs and collection status/count refresh. | Not executed. | NOT TESTED | Requires native runtime. |
| Product drilldown from collection works | Not available | Tap a product card inside collection viewer. | Product Commerce Viewer opens for that product. | Not executed. | NOT TESTED | Requires native route runtime. |
| Back from product returns to collection viewer | Not available | From product viewer opened from collection, tap back. | User returns to the original collection viewer context. | Not executed. | NOT TESTED | Requires native route runtime. |
| Back from collection returns to Market | Not available | From collection viewer, tap top-left back. | User returns to Market or previous route context. | Not executed. | NOT TESTED | Requires native route runtime. |
| Already-in-bag product is not duplicated | Not available | Open already-in-bag seeded collection; tap Bag All or selected action. | Already-in-bag product is skipped and not duplicated. | Not executed. | NOT TESTED | Requires seeded buyer bag state. |
| Out-of-stock product is clearly blocked | Not available | Open mixed collection with out-of-stock product. | Out-of-stock product is disabled/blocked with clear reason. | Not executed. | NOT TESTED | Requires seeded mixed collection. |
| My Bag count updates after collection bagging | Not available | Add collection products; observe My Bag island count. | `/bag/count` combined count refreshes once after mutation. | Not executed. | NOT TESTED | Requires mutation-capable native runtime. |
| Logged-out Bag All/Bag Selected prompts auth/resume | Not available | Sign out; open public collection; tap Bag All or Bag Selected. | Auth prompt opens with resume route back to collection viewer. | Not executed. | NOT TESTED | Requires native auth runtime. |
| Own-brand collection bagging is blocked | Not available | Sign in as collection-owning brand; open own collection; tap collection bag action. | Own-brand action is disabled/blocked by backend readiness. | Not executed. | NOT TESTED | Requires brand-owner native session. |
| Gallery opens from collection viewer | Not available | Tap Gallery from collection viewer. | `/collection-gallery` opens full-screen media viewer. | Not executed. | NOT TESTED | Requires native runtime. |
| Gallery swipes/flips through media | Not available | Open gallery collection with multiple media; swipe horizontally. | Media pages change and count updates. | Not executed. | NOT TESTED | Requires seeded gallery collection. |
| Gallery back returns to collection viewer | Not available | From gallery, tap back. | User returns to collection viewer. | Not executed. | NOT TESTED | Requires native route runtime. |
| Shop Collection CTA returns to collection viewer | Not available | From gallery, tap Shop Collection. | User returns to collection viewer. | Not executed. | NOT TESTED | Requires native route runtime. |
| Reviews hidden when feature flag OFF | Not available | Open collection viewer with default review flags. | No collection review list/composer/comment UI appears. | Not executed. | NOT TESTED | Requires native runtime. |
| Collection share works | Not available | Open collection viewer; tap Share. | Native share sheet opens and cancel does not error. | Not executed. | NOT TESTED | Requires native share sheet. |
| Message brand works | Not available | Open collection viewer; tap Message Brand. | Message route opens or auth prompt appears; own-brand is blocked. | Not executed. | NOT TESTED | Requires messaging-capable native session. |
| Collection save disabled or works according to API support | Not available | Tap Save on collection viewer. | Collection save toggles through saved-items API with loading/error handling. | Not executed. | NOT TESTED | Requires authenticated native runtime. |

## Validation Commands

- `npm exec tsc -- --noEmit`: PASS in Phase 16C&D automated validation.
- `npm run ci:design-system`: PASS.
- `npm run audit:theme`: PASS.
