import { resolveRequiredBrandField } from './brand-profile-source.helper';
import { resolveRequiredProfileField } from './user-profile-source.helper';

/**
 * ONE way to turn a user row into the name a human should read.
 *
 * Before this existed, messaging built display names in three places and all
 * three did `firstName || username || id`. Two problems came out of that:
 *
 *  1. Shoppers showed a single given name — "Jayde" where "Jayde Druid" was
 *     meant. A first name alone is not an identity in a list of conversations;
 *     two Jaydes are indistinguishable.
 *  2. Brands showed the OWNER's first name. A brand user's `firstName` is the
 *     person who registered the account, not the storefront the shopper is
 *     talking to, so a thread with "Sotheria" was labelled with a stranger's
 *     given name.
 *
 * The rule this encodes: a BRAND is named by its brand name; everyone else is
 * named by their full name. Anything that shows a name to a human should call
 * this rather than reaching for a field, so the two cases can never drift apart
 * again.
 */

/** The shape this needs — deliberately loose so any selected row satisfies it. */
export type DisplayNameSource = {
  id?: string | null;
  type?: string | null;
  username?: string | null;
  /** Canonical profile source (Phase 2) — where first/last name actually live. */
  userProfile?: { firstName?: string | null; lastName?: string | null } | null;
  /** Canonical brand source (Phase 3) — where the brand name actually lives. */
  brand?: { name?: string | null } | null;
} | null | undefined;

const clean = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/**
 * Is this row a brand account?
 *
 * `type === 'BRAND'` is the declaration, but a row selected without `type`
 * would silently fall through to the person branch and show the owner's name.
 * So the presence of a brand name counts too: only brand accounts have one.
 */
function isBrandAccount(user: NonNullable<DisplayNameSource>): boolean {
  if (clean(user.type).toUpperCase() === 'BRAND') return true;
  return clean(user.brand?.name).length > 0;
}

/** A shopper's full name — both parts when we have both. */
export function resolvePersonFullName(user: DisplayNameSource): string {
  if (!user) return '';
  const first = clean(resolveRequiredProfileField(user as any, 'firstName'));
  const last = clean(resolveRequiredProfileField(user as any, 'lastName'));
  return [first, last].filter(Boolean).join(' ');
}

/**
 * The name to show for `user`, or `fallback` when the row carries no name at all.
 *
 * `id` is deliberately NOT a fallback here. The old helper ended in `|| user.id`,
 * which meant a row missing its profile put a raw UUID in front of the reader
 * (and into push notification titles). A caller-supplied word — "Brand",
 * "User" — is always better than a database key.
 */
export function resolveDisplayName(
  user: DisplayNameSource,
  fallback = '',
): string {
  if (!user) return fallback;

  if (isBrandAccount(user)) {
    const brandName =
      clean(resolveRequiredBrandField(user as any, 'brandFullName')) ||
      clean(user.brand?.name);
    if (brandName) return brandName;
  }

  return resolvePersonFullName(user) || clean(user.username) || fallback;
}
