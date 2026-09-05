/**
 * The single source for WIEZ's name and palette on the backend.
 *
 * Export names match `fthreadly/src/brand/identity.ts` and
 * `threadly-mobile/src/brand/identity.ts` exactly, so a value can be grepped
 * across all three repos. They cannot import each other — three separate git
 * repos, no shared package — so the guarantee is a pinning test per repo.
 *
 * Removed here, all with zero consumers: `PRODUCT_NAME_LEGAL` (a duplicate of
 * `PRODUCT_NAME`), `PRODUCT_NAME_FORMER` (a `@deprecated` marker whose value
 * was the current name), `PRODUCT_LOGO_TAGLINE`, and two placeholder constants
 * that only restated a string already inlined at its one use site — plus four
 * *_ENV_KEY constants that named an environment variable nothing ever read.
 */

/** The product name. There is no former name to surface anywhere. */
export const PRODUCT_NAME = 'WIEZ';

export const PRODUCT_TAGLINE = 'When you think WEARS, you think WIEZ.';

export const PRODUCT_CATEGORY = 'African fashion social commerce marketplace';

/**
 * The brand palette, as actually painted.
 *
 * What was here before was a navy-and-gold set (`#16233f` / `#d8b24a`) that the
 * email shell dressed itself in while the product UI was violet — the gold rule
 * across the top of every transactional email belonged to a brand the app had
 * stopped being.
 *
 * `primary` and `onDark` are a pair, not two shades of one colour: `primary`
 * clears white at 7.8:1 and `onDark` clears the brand ground at 7.1:1, and
 * neither survives on the other side — `primary` sits at 1.9:1 on ink. Email
 * headers sit on `ink`, so anything drawn on them uses `onDark`.
 */
export const BRAND_COLORS = {
  primary: '#6015e2',
  primaryStrong: '#4e11b8',
  onDark: '#af87f4',
  soft: '#a97ef3',
  ink: '#0c0b11',
} as const;
