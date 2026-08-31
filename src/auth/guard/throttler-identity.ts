import * as jwt from 'jsonwebtoken';

/**
 * Who is this request, for the purpose of COUNTING it?
 *
 * Kept as a pure module, separate from the guard, because the security of the
 * whole rate limiter now rests on these ~40 lines and they should be testable
 * without standing up a Nest execution context.
 *
 * ## Why this exists
 *
 * The throttler runs as a global `APP_GUARD`. NestJS builds a route's guard
 * chain as `globalGuards.concat(scopedGuards)` (verified in @nestjs/core
 * 11.1.19, `guards-context-creator.js`), so every global guard runs BEFORE the
 * route-level `JwtAuthGuard` that populates `req.user`. The previous tracker
 * read `req.user` and therefore never found anyone: every request, signed in or
 * not, was counted against its IP alone.
 *
 * That is fine until users share an IP — and on Nigerian mobile networks they
 * routinely do, because carrier-grade NAT puts many subscribers behind one
 * public address. One person's browsing then consumed a quota everyone else
 * behind that carrier was also drawing from.
 *
 * ## The rule that makes this safe
 *
 * The signature is ALWAYS verified. Never `jwt.decode`.
 *
 * A decoded-but-unverified token would let anyone mint a fresh quota by
 * inventing a `sub` — turning the fix into a bypass strictly worse than the
 * problem it replaces. Verification is what makes a user identity *earned*
 * rather than *claimed*.
 *
 * Everything else fails soft: an expired, forged, malformed or absent token is
 * not an error here, it just means "we could not identify anyone", and the
 * caller falls back to the IP. This code makes no authorization decision and
 * must never be the reason a request is allowed through — `JwtAuthGuard` still
 * does that, later and independently.
 *
 * No database lookup: the signed `sub` is enough to count against, and a query
 * per request would put Postgres in the path of every rate-limit check.
 */

/** Claims we care about. The token carries more; counting needs only these. */
type CountableClaims = { sub?: unknown; exp?: unknown };

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * Access tokens arrive two ways and both must be handled, because the web app
 * uses a cookie and the mobile app uses an Authorization header. `JwtStrategy`
 * reads cookie first, then bearer; this mirrors that order so the two agree
 * about which token identifies a request.
 */
export function extractAccessToken(
  req: Record<string, any>,
  cookieName: string,
): string | null {
  const cookies = req?.cookies as Record<string, unknown> | undefined;
  const fromCookie = cookies?.[cookieName];
  if (typeof fromCookie === 'string' && fromCookie.trim()) {
    return fromCookie.trim();
  }

  const header = req?.headers?.authorization;
  if (typeof header === 'string') {
    const match = BEARER.exec(header.trim());
    if (match?.[1]?.trim()) return match[1].trim();
  }

  return null;
}

/**
 * Verified subjects, cached by token.
 *
 * MEASURED, not assumed: on this hardware `jwt.verify` costs ~808µs while the
 * HMAC it performs costs ~2.2µs. The other ~806µs is `jsonwebtoken`'s wrapper —
 * option normalization, JSON parsing, claim validation, allocation. Running
 * that on every request would put roughly 8% of a core at 100 rps into
 * *identifying* traffic before any of it is served, on a host already at 88%
 * memory. Rate limiting is supposed to protect the box, not tax it.
 *
 * A session sends the same token over and over, so a small cache turns almost
 * every check into a map lookup.
 *
 * Two rules keep it honest:
 *  - **Only successes are cached.** A rejection must stay cheap to re-evaluate,
 *    because during a secret-rotation window a token that fails against the old
 *    secret list can legitimately start passing against the new one.
 *  - **An entry never outlives the token's own `exp`.** Otherwise an expired
 *    token would keep buying a user-scoped quota after it stopped being valid.
 */
const VERIFIED_CACHE_MAX = 1000;
const verifiedCache = new Map<string, { userId: string; expiresAtMs: number }>();

/** Bounded FIFO: `Map` preserves insertion order, so the oldest key is first. */
function rememberVerified(token: string, userId: string, expiresAtMs: number) {
  if (verifiedCache.size >= VERIFIED_CACHE_MAX) {
    const oldest = verifiedCache.keys().next().value;
    if (oldest !== undefined) verifiedCache.delete(oldest);
  }
  verifiedCache.set(token, { userId, expiresAtMs });
}

/** Exposed for tests; the cache is process-local and holds no secrets. */
export function resetVerifiedTokenCache() {
  verifiedCache.clear();
}

/**
 * `secrets` is a list to support the zero-downtime rotation window that
 * `getJwtVerificationSecrets` already implements — during rotation a valid
 * token may be signed with either the current or the previous secret, and a
 * user must not silently drop back to IP-based counting mid-rotation.
 */
export function resolveVerifiedUserId(
  token: string | null,
  secrets: readonly string[],
): string | null {
  if (!token) return null;

  const now = Date.now();
  const cached = verifiedCache.get(token);
  if (cached) {
    if (cached.expiresAtMs > now) return cached.userId;
    verifiedCache.delete(token);
  }

  for (const secret of secrets) {
    try {
      const claims = jwt.verify(token, secret) as CountableClaims;
      const sub = claims?.sub;
      if (typeof sub !== 'string' || !sub.trim()) {
        // Verified but subject-less: a real token we cannot count by user.
        return null;
      }

      const userId = sub.trim();
      // `exp` is seconds since epoch. A token without one is still valid to
      // count, but gets only a short cache lease rather than an unbounded one.
      const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
      rememberVerified(token, userId, exp > now ? exp : now + 60_000);
      return userId;
    } catch {
      // Wrong secret during rotation, expired, tampered, malformed — all mean
      // "not identified". Try the next secret, then fall back to IP.
    }
  }

  return null;
}

/**
 * The tracker string the throttler counts against.
 *
 * Prefixes are not decoration: without them a user id that happened to look
 * like an IP could share a bucket with that IP. Distinct namespaces make a
 * collision impossible rather than unlikely.
 *
 * Authenticated requests are keyed by USER ALONE, deliberately not `ip:user`.
 * Keying on both would hand an attacker a fresh quota for every IP they can
 * reach from — rotating IPs on one account would multiply their budget — while
 * doing nothing extra for the legitimate user it is meant to protect. Keying on
 * the account means the limit follows the account, which is the thing we
 * actually want to bound.
 */
export function buildTracker(userId: string | null, ip: string): string {
  return userId ? `user:${userId}` : `ip:${ip}`;
}
