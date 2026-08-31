import * as jwt from 'jsonwebtoken';
import { AppThrottlerGuard } from './app-throttler.guard';
import {
  buildTracker,
  extractAccessToken,
  resetVerifiedTokenCache,
  resolveVerifiedUserId,
} from './throttler-identity';

/**
 * Rate-limit identity.
 *
 * These tests exist because the bug they cover was invisible: the guard already
 * contained the code to count authenticated users separately, and that code
 * simply never ran, because global guards execute before the route-level
 * `JwtAuthGuard` that would have populated `req.user`. Nothing failed. Nothing
 * logged. Every signed-in user was quietly counted against their IP.
 *
 * So the suite asserts BEHAVIOUR (two accounts on one IP get separate quotas),
 * not implementation, and it pins the security property that makes the fix safe
 * rather than dangerous: an identity has to be proven by signature, never
 * merely claimed.
 */

const SECRET = 'test-access-secret-value';
const PREVIOUS_SECRET = 'test-previous-secret-value';
const COOKIE = 'accessToken';

const signFor = (sub: string, secret = SECRET, options: jwt.SignOptions = {}) =>
  jwt.sign({ sub, username: 'x', role: 'User' }, secret, {
    expiresIn: '10m',
    ...options,
  });

/** Minimal stand-in for the Express request the guard actually receives. */
const request = (over: Record<string, any> = {}) => ({
  ip: '102.89.42.51',
  headers: {},
  cookies: {},
  ...over,
});

/**
 * Exercises the real guard method rather than the helpers, so the wiring
 * between them is covered too. `getTracker` is protected by design; reaching it
 * here is deliberate and is the only way to test the actual code path.
 */
const trackerFor = (req: Record<string, any>, secrets = [SECRET]) => {
  const guard = Object.create(AppThrottlerGuard.prototype) as any;
  guard.cookieName = COOKIE;
  guard.verificationSecrets = secrets;
  guard.getSecrets = () => secrets;
  return guard.getTracker(req) as Promise<string>;
};

describe('AppThrottlerGuard — rate-limit identity', () => {
  // The verified-token cache is process-local and shared between tests; a stale
  // entry would make a later assertion pass for the wrong reason.
  beforeEach(() => resetVerifiedTokenCache());

  describe('verified-token cache', () => {
    it('returns the same subject on a repeat call', async () => {
      const token = signFor('user-alpha');
      expect(resolveVerifiedUserId(token, [SECRET])).toBe('user-alpha');
      expect(resolveVerifiedUserId(token, [SECRET])).toBe('user-alpha');
    });

    it('does NOT serve a cached identity past the token expiry', async () => {
      // The security property that makes caching safe: a token that expires
      // between two requests must stop buying a user-scoped quota.
      const token = signFor('user-alpha', SECRET, { expiresIn: '2s' });
      expect(resolveVerifiedUserId(token, [SECRET])).toBe('user-alpha');

      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 3_000; // walk past exp
        expect(resolveVerifiedUserId(token, [SECRET])).toBeNull();
      } finally {
        Date.now = realNow;
      }
    });

    it('does not cache rejections, so rotation can start accepting a token', async () => {
      // Signed with the PREVIOUS secret. First seen before rotation adds it,
      // then again after — the second call must succeed, not replay a miss.
      const token = signFor('user-alpha', PREVIOUS_SECRET);
      expect(resolveVerifiedUserId(token, [SECRET])).toBeNull();
      expect(resolveVerifiedUserId(token, [SECRET, PREVIOUS_SECRET])).toBe(
        'user-alpha',
      );
    });

    it('stays bounded under many distinct tokens', async () => {
      // Memory matters here: the SIT host runs at ~88% RAM. 1,500 unique
      // tokens must not retain 1,500 entries.
      for (let i = 0; i < 1_500; i += 1) {
        resolveVerifiedUserId(signFor(`user-${i}`), [SECRET]);
      }
      // Oldest entries evicted; the most recent token still resolves.
      const recent = signFor('user-final');
      expect(resolveVerifiedUserId(recent, [SECRET])).toBe('user-final');
    });
  });

  describe('anonymous callers fall back to IP', () => {
    it('keys an unauthenticated request on its IP', async () => {
      await expect(trackerFor(request())).resolves.toBe('ip:102.89.42.51');
    });

    it('keys on IP when the IP is unavailable rather than throwing', async () => {
      const req = request({ ip: undefined, ips: undefined });
      await expect(trackerFor(req)).resolves.toBe('ip:unknown');
    });

    it('falls back to the first forwarded address when req.ip is absent', async () => {
      const req = request({ ip: undefined, ips: ['41.58.1.9'] });
      await expect(trackerFor(req)).resolves.toBe('ip:41.58.1.9');
    });
  });

  describe('authenticated callers are counted per account', () => {
    it('keys a bearer-token request on the verified subject', async () => {
      const req = request({
        headers: { authorization: `Bearer ${signFor('user-alpha')}` },
      });
      await expect(trackerFor(req)).resolves.toBe('user:user-alpha');
    });

    it('keys a cookie-token request on the verified subject', async () => {
      const req = request({ cookies: { [COOKIE]: signFor('user-alpha') } });
      await expect(trackerFor(req)).resolves.toBe('user:user-alpha');
    });

    it('prefers an already-attached req.user over re-verifying', async () => {
      const req = request({ user: { id: 'attached-user' } });
      await expect(trackerFor(req)).resolves.toBe('user:attached-user');
    });

    it('accepts a token signed with the PREVIOUS secret during rotation', async () => {
      // A user mid-rotation must not silently drop back to IP counting, which
      // would re-create the shared-quota bug for the length of the window.
      const req = request({
        headers: {
          authorization: `Bearer ${signFor('user-alpha', PREVIOUS_SECRET)}`,
        },
      });
      await expect(
        trackerFor(req, [SECRET, PREVIOUS_SECRET]),
      ).resolves.toBe('user:user-alpha');
    });
  });

  describe('CGNAT: two accounts behind one IP do not share a quota', () => {
    it('gives different trackers to different users on the SAME IP', async () => {
      const ip = '105.112.7.40'; // one carrier-NAT address, two subscribers
      const first = await trackerFor(
        request({ ip, headers: { authorization: `Bearer ${signFor('user-a')}` } }),
      );
      const second = await trackerFor(
        request({ ip, headers: { authorization: `Bearer ${signFor('user-b')}` } }),
      );

      expect(first).toBe('user:user-a');
      expect(second).toBe('user:user-b');
      expect(first).not.toBe(second);
    });

    it('gives one account the SAME tracker across different IPs', async () => {
      // The quota follows the account. Rotating IPs must not mint new budget.
      const token = signFor('user-a');
      const fromHome = await trackerFor(
        request({ ip: '105.112.7.40', headers: { authorization: `Bearer ${token}` } }),
      );
      const fromCafe = await trackerFor(
        request({ ip: '197.210.1.2', headers: { authorization: `Bearer ${token}` } }),
      );

      expect(fromHome).toBe(fromCafe);
    });

    it('still shares one bucket between two ANONYMOUS callers on one IP', async () => {
      // Unchanged and intended: anonymous traffic has no identity to separate.
      const ip = '105.112.7.40';
      const a = await trackerFor(request({ ip }));
      const b = await trackerFor(request({ ip }));
      expect(a).toBe(b);
      expect(a).toBe('ip:105.112.7.40');
    });
  });

  describe('a tracker cannot be forged', () => {
    it('ignores a token signed with the WRONG secret', async () => {
      const req = request({
        headers: { authorization: `Bearer ${signFor('attacker', 'wrong-secret')}` },
      });
      await expect(trackerFor(req)).resolves.toBe('ip:102.89.42.51');
    });

    it('ignores an unsigned (alg=none) token', async () => {
      // The classic forgery. If this ever passes, anyone can mint unlimited
      // quota by inventing a subject — a worse bypass than the bug being fixed.
      const forged = jwt.sign({ sub: 'attacker' }, '', { algorithm: 'none' });
      const req = request({ headers: { authorization: `Bearer ${forged}` } });
      await expect(trackerFor(req)).resolves.toBe('ip:102.89.42.51');
    });

    it('ignores an EXPIRED token', async () => {
      const expired = signFor('user-alpha', SECRET, { expiresIn: '-1m' });
      const req = request({ headers: { authorization: `Bearer ${expired}` } });
      await expect(trackerFor(req)).resolves.toBe('ip:102.89.42.51');
    });

    it('ignores a tampered payload', async () => {
      const [header, , signature] = signFor('user-alpha').split('.');
      const swapped = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString(
        'base64url',
      );
      const req = request({
        headers: { authorization: `Bearer ${header}.${swapped}.${signature}` },
      });
      await expect(trackerFor(req)).resolves.toBe('ip:102.89.42.51');
    });

    it('ignores malformed and empty tokens without throwing', async () => {
      for (const value of ['Bearer', 'Bearer ', 'Bearer not-a-jwt', 'Basic abc']) {
        const req = request({ headers: { authorization: value } });
        await expect(trackerFor(req)).resolves.toBe('ip:102.89.42.51');
      }
    });

    it('falls back to IP when no verification secret is configured', async () => {
      const req = request({
        headers: { authorization: `Bearer ${signFor('user-alpha')}` },
      });
      await expect(trackerFor(req, [])).resolves.toBe('ip:102.89.42.51');
    });
  });

  describe('forwarded-IP headers cannot move an authenticated bucket', () => {
    /*
      Verified against SIT on 2026-08-31: TRUST_PROXY="true" maps to Express
      `trust proxy = 1`, Caddy appends the real client address, and a request
      carrying a forged 3-hop X-Forwarded-For plus CF-Connecting-IP,
      True-Client-IP and X-Real-IP was still logged with the real IP.

      The guard reads `req.ip` — already resolved by Express — and never reads a
      forwarded header itself. These tests pin that: headers on the request must
      not change the tracker.
    */
    const spoofHeaders = {
      'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.10.11.12',
      'cf-connecting-ip': '66.66.66.66',
      'true-client-ip': '77.77.77.77',
      'x-real-ip': '88.88.88.88',
    };

    it('does not let spoofed headers change an ANONYMOUS tracker', async () => {
      const clean = await trackerFor(request({ ip: '102.89.42.51' }));
      const spoofed = await trackerFor(
        request({ ip: '102.89.42.51', headers: { ...spoofHeaders } }),
      );
      expect(spoofed).toBe(clean);
      expect(spoofed).toBe('ip:102.89.42.51');
    });

    it('does not let spoofed headers change an AUTHENTICATED tracker', async () => {
      const req = request({
        ip: '102.89.42.51',
        headers: {
          ...spoofHeaders,
          authorization: `Bearer ${signFor('user-alpha')}`,
        },
      });
      await expect(trackerFor(req)).resolves.toBe('user:user-alpha');
    });
  });

  describe('tracker namespacing', () => {
    it('cannot collide a user id with an IP address', async () => {
      // A user id shaped like an IP must not land in that IP's bucket.
      expect(buildTracker('102.89.42.51', '9.9.9.9')).toBe('user:102.89.42.51');
      expect(buildTracker(null, '102.89.42.51')).toBe('ip:102.89.42.51');
      expect(buildTracker('102.89.42.51', '9.9.9.9')).not.toBe(
        buildTracker(null, '102.89.42.51'),
      );
    });
  });

  describe('token extraction', () => {
    it('prefers the cookie over the Authorization header, matching JwtStrategy', async () => {
      const req = request({
        cookies: { [COOKIE]: 'cookie-token' },
        headers: { authorization: 'Bearer header-token' },
      });
      expect(extractAccessToken(req, COOKIE)).toBe('cookie-token');
    });

    it('returns null when neither carrier is present', () => {
      expect(extractAccessToken(request(), COOKIE)).toBeNull();
    });

    it('never throws on a hostile request shape', () => {
      expect(() => extractAccessToken({} as any, COOKIE)).not.toThrow();
      expect(resolveVerifiedUserId(null, [SECRET])).toBeNull();
    });
  });
});
