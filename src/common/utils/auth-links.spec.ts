import {
  buildAdminPasswordResetLink,
  buildAppLinkBridgeHtml,
  buildEmailChangeConfirmationLink,
  buildEmailVerificationLink,
  buildPasswordResetLink,
  resolveMobileAppBridgeBaseUrl,
  sanitizeAuthNextPath,
} from './auth-links';

const ORIGINAL_ENV = process.env;

function resetEnv(overrides: NodeJS.ProcessEnv = {}) {
  process.env = {
    ...ORIGINAL_ENV,
    APP_ENV: undefined,
    DEPLOY_ENV: undefined,
    NODE_ENV: 'test',
    WEB_APP_URL: 'https://app.wiez.test/',
    FRONTEND_URL: undefined,
    WEB_APP_USE_HTTPS: undefined,
    WEB_APP_HOST: undefined,
    WEB_APP_PORT: undefined,
    ...overrides,
  };
}

describe('auth link builders', () => {
  beforeEach(() => {
    resetEnv();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('builds a password reset URL from WEB_APP_URL', () => {
    expect(buildPasswordResetLink('raw token/+')).toBe(
      'https://app.wiez.test/reset-password?token=raw%20token%2F%2B',
    );
  });

  it('builds an admin password reset URL from WEB_APP_URL', () => {
    expect(buildAdminPasswordResetLink('admin token/+')).toBe(
      'https://app.wiez.test/admin/reset-password?token=admin%20token%2F%2B',
    );
  });

  it('builds an email verification URL with a safe next path', () => {
    expect(
      buildEmailVerificationLink('verify token/+', '/profile?tab=Account'),
    ).toBe(
      'https://app.wiez.test/verify-email?token=verify%20token%2F%2B&next=%2Fprofile%3Ftab%3DAccount',
    );
  });

  it('drops unsafe or empty email verification next paths', () => {
    expect(buildEmailVerificationLink('token', '')).toBe(
      'https://app.wiez.test/verify-email?token=token',
    );
    expect(buildEmailVerificationLink('token', '//evil.com')).toBe(
      'https://app.wiez.test/verify-email?token=token',
    );
    expect(buildEmailVerificationLink('token', 'https://evil.com/reset')).toBe(
      'https://app.wiez.test/verify-email?token=token',
    );
    expect(buildEmailVerificationLink('token', 'http://evil.com/reset')).toBe(
      'https://app.wiez.test/verify-email?token=token',
    );
  });

  // A raw `wiezmobile://` href in an email is stripped by Gmail and most other
  // clients: the anchor survives, the link does not, and the user sees a button
  // that renders perfectly and does nothing when tapped. Emails must only ever
  // carry http(s).
  describe('mobile links must stay clickable in email clients', () => {
    it('uses the https bridge when one is known', () => {
      expect(
        buildEmailVerificationLink('tok', null, {
          mobile: true,
          bridgeBaseUrl: 'https://api.wiez.test/',
        }),
      ).toBe('https://api.wiez.test/auth/app-link/verify-email?token=tok');
    });

    it('falls back to the WEB link, never the custom scheme, with no bridge', () => {
      const verify = buildEmailVerificationLink('tok', null, { mobile: true });
      const reset = buildPasswordResetLink('tok', { mobile: true });

      expect(verify).toBe('https://app.wiez.test/verify-email?token=tok');
      expect(reset).toBe('https://app.wiez.test/reset-password?token=tok');
      for (const link of [verify, reset]) {
        expect(link.startsWith('http')).toBe(true);
        expect(link).not.toContain('wiezmobile://');
      }
    });

    it('still honours MOBILE_APP_URL when it is a real https universal link', () => {
      resetEnv({ MOBILE_APP_URL: 'https://links.wiez.test/' });
      expect(buildEmailVerificationLink('tok', null, { mobile: true })).toBe(
        'https://links.wiez.test/verify-email?token=tok',
      );
    });

    it('ignores a custom-scheme MOBILE_APP_URL', () => {
      resetEnv({ MOBILE_APP_URL: 'wiezmobile://' });
      expect(buildEmailVerificationLink('tok', null, { mobile: true })).toBe(
        'https://app.wiez.test/verify-email?token=tok',
      );
    });
  });

  // A base URL that is not absolute cannot be linkified: the client keeps the
  // anchor and drops the destination, so the button renders and does nothing.
  // The real incident was `APP_PUBLIC_URL=APP_PUBLIC_URL=https://…` — the whole
  // KEY=value line pasted as the value.
  describe('malformed base URLs never reach an href', () => {
    it('ignores a bridge base that is not an absolute URL', () => {
      const link = buildEmailVerificationLink('tok', null, {
        mobile: true,
        bridgeBaseUrl: 'APP_PUBLIC_URL=http://10.0.0.1:3000',
      });

      expect(link).toBe('https://app.wiez.test/verify-email?token=tok');
      expect(link.startsWith('https://')).toBe(true);
    });

    it('ignores a quoted bridge base carrying its own key', () => {
      expect(
        buildPasswordResetLink('tok', {
          mobile: true,
          bridgeBaseUrl: '"APP_PUBLIC_URL=https://api.wiez.test"',
        }),
      ).toBe('https://app.wiez.test/reset-password?token=tok');
    });

    it('still uses a well-formed bridge base', () => {
      expect(
        buildEmailVerificationLink('tok', null, {
          mobile: true,
          bridgeBaseUrl: '  https://api.wiez.test/  ',
        }),
      ).toBe('https://api.wiez.test/auth/app-link/verify-email?token=tok');
    });

    it('rejects a WEB_APP_URL that carries its own key', () => {
      resetEnv({ WEB_APP_URL: 'WEB_APP_URL=https://app.wiez.test' });
      // Falls through to the local default rather than emitting a dead href.
      expect(buildEmailVerificationLink('tok')).toBe(
        'http://localhost:3000/verify-email?token=tok',
      );
    });
  });

  // The bridge page is the surface the email button now lands on, so it owns
  // the same failure mode the email did: a `wiezmobile://` anchor is a no-op in
  // Chrome and in the Gmail in-app browser. Every VISIBLE link here must be
  // http(s); the app hand-off happens in script, not in the only button.
  describe('open-in-app bridge page', () => {
    it('renders no custom-scheme anchor at all', () => {
      const html = buildAppLinkBridgeHtml('verify-email', {
        token: 'tok',
        next: '/catalog',
      });

      const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(
        (match) => match[1],
      );
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(href.startsWith('https://')).toBe(true);
      }
    });

    it('makes the primary button complete the action on the web', () => {
      const html = buildAppLinkBridgeHtml('verify-email', {
        token: 'tok',
        next: '/catalog',
      });

      expect(html).toContain(
        'href="https://app.wiez.test/verify-email?token=tok&amp;next=%2Fcatalog"',
      );
      expect(html).toContain('Confirm my email');
    });

    it('hands off to the app through script, with an Android intent URL', () => {
      const html = buildAppLinkBridgeHtml('reset-password', { token: 'tok' });

      expect(html).toContain('wiezmobile://reset-password/tok?token=tok');
      expect(html).toContain('intent://reset-password/tok?token=tok#Intent');
      expect(html).toContain('scheme=wiezmobile');
      expect(html).toContain('package=com.wiez.wiez');
      expect(html).toContain('S.browser_fallback_url=');
      // …and still leaves a working https button behind.
      expect(html).toContain('href="https://app.wiez.test/reset-password?token=tok"');
    });
  });

  it('builds the public email change confirmation route', () => {
    expect(buildEmailChangeConfirmationLink('email token/+')).toBe(
      'https://app.wiez.test/change-email/confirm?token=email%20token%2F%2B',
    );
  });

  it('sanitizes next paths to same-app absolute paths only', () => {
    expect(sanitizeAuthNextPath('/profile')).toBe('/profile');
    expect(sanitizeAuthNextPath(' /settings?tab=account-security ')).toBe(
      '/settings?tab=account-security',
    );
    expect(sanitizeAuthNextPath('')).toBeNull();
    expect(sanitizeAuthNextPath('profile')).toBeNull();
    expect(sanitizeAuthNextPath('//evil.com')).toBeNull();
    expect(sanitizeAuthNextPath('https://evil.com/profile')).toBeNull();
    expect(sanitizeAuthNextPath('http://evil.com/profile')).toBeNull();
  });

  it('rejects next paths a browser would read as another site', () => {
    // Browsers treat `\` as `/` and strip tabs/newlines inside URLs.
    for (const attack of [
      '/\\evil.com',
      '/\\/evil.com',
      '/\t/evil.com',
      '/\n/evil.com',
      '/\r/evil.com',
      '///evil.com',
      'javascript:alert(1)',
    ]) {
      expect(sanitizeAuthNextPath(attack)).toBeNull();
    }
  });

  it('keeps a same-site next path as the parser reads it', () => {
    expect(sanitizeAuthNextPath('/orders/abc?tab=open#top')).toBe(
      '/orders/abc?tab=open#top',
    );
    expect(sanitizeAuthNextPath('/a/../profile')).toBe('/profile');
    // Encoded characters stay encoded: still a path on this site.
    expect(sanitizeAuthNextPath('/%2F%2Fevil.com')).toBe('/%2F%2Fevil.com');
    expect(sanitizeAuthNextPath('/%00/evil.com')).toBe('/%00/evil.com');
  });

  describe('bridge base never comes from request headers outside local dev', () => {
    const forged = {
      host: 'evil.example',
      protocol: 'https',
      forwardedProto: 'https',
    };

    it('ignores a forged host on SIT and production', () => {
      for (const APP_ENV of ['sit', 'production']) {
        resetEnv({ APP_ENV, APP_PUBLIC_URL: undefined });
        expect(resolveMobileAppBridgeBaseUrl(forged)).toBe('');
      }
    });

    it('uses the configured public URL whatever the request says', () => {
      resetEnv({ APP_ENV: 'sit', APP_PUBLIC_URL: 'https://api.wiez.test' });
      expect(resolveMobileAppBridgeBaseUrl(forged)).toBe(
        'https://api.wiez.test',
      );
    });

    it('sends a forged-host mobile reset to the web link, not the forged host', () => {
      resetEnv({ APP_ENV: 'sit', APP_PUBLIC_URL: undefined });
      const link = buildPasswordResetLink('tok', {
        mobile: true,
        bridgeBaseUrl: resolveMobileAppBridgeBaseUrl(forged),
      });
      expect(link).toBe('https://app.wiez.test/reset-password?token=tok');
    });

    it('still derives the LAN host in local development', () => {
      resetEnv({ APP_PUBLIC_URL: undefined });
      expect(resolveMobileAppBridgeBaseUrl({ host: '192.168.1.5:3040' })).toBe(
        'http://192.168.1.5:3040',
      );
    });
  });
});
