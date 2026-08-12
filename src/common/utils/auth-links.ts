import { resolveWebAppBaseUrl } from './web-app-url';

function resolveAuthLinkBaseUrl(): string {
  return resolveWebAppBaseUrl().replace(/\/+$/, '');
}

/**
 * Base for deep links that should open the native app instead of the web app.
 * Defaults to the Expo custom scheme (`wiezmobile://`) so a verification link
 * tapped on a phone launches the installed app and lands on `/verify-email`.
 * Override with `MOBILE_APP_URL` for a universal/https link once a verified
 * associated domain is hosted. Always returned with a trailing slash so a path
 * can be appended directly.
 */
function resolveMobileAuthLinkBaseUrl(): string {
  const configured = String(process.env.MOBILE_APP_URL ?? '').trim();
  const base = configured || 'wiezmobile://';
  return base.endsWith('/') ? base : `${base}/`;
}

/**
 * Public, reachable base URL of THIS backend, used for the HTTPS "open in app"
 * bridge links in auth emails. Gmail (and most clients) strip raw custom-scheme
 * (`wiezmobile://`) links, so the email must contain an https/http link the
 * client keeps; that link hits the backend bridge page which then redirects
 * into the app scheme.
 *
 * Prefers `APP_PUBLIC_URL`; otherwise derives from the originating request host
 * (in local dev this is the LAN host the phone already used to reach the API,
 * so it is reachable from the same device).
 */
export function resolveMobileAppBridgeBaseUrl(req?: {
  host?: string | null;
  protocol?: string | null;
  forwardedProto?: string | null;
}): string {
  const configured = String(process.env.APP_PUBLIC_URL ?? '').trim();
  if (configured) return configured.replace(/\/+$/, '');

  const host = String(req?.host ?? '').trim();
  if (!host) return '';

  const proto =
    String(req?.forwardedProto ?? '')
      .split(',')[0]
      ?.trim() ||
    String(req?.protocol ?? '').trim() ||
    'http';
  return `${proto}://${host}`;
}

function encodeToken(token: string): string {
  return encodeURIComponent(String(token));
}

/**
 * Raw custom-scheme deep link (e.g. `wiezmobile://verify-email?token=...`). Used
 * by the bridge page's redirect — NOT placed directly in emails.
 */
export function buildMobileSchemeAuthLink(
  route: 'verify-email' | 'reset-password',
  token: string,
  nextPath?: string | null,
): string {
  const sanitizedNextPath =
    route === 'verify-email' ? sanitizeAuthNextPath(nextPath) : null;
  const nextQuery = sanitizedNextPath
    ? `&next=${encodeURIComponent(sanitizedNextPath)}`
    : '';
  return `${resolveMobileAuthLinkBaseUrl()}${route}?token=${encodeToken(token)}${nextQuery}`;
}

export function sanitizeAuthNextPath(nextPath?: string | null): string | null {
  const candidate = String(nextPath ?? '').trim();
  if (!candidate) {
    return null;
  }

  if (!candidate.startsWith('/')) {
    return null;
  }

  if (candidate.startsWith('//')) {
    return null;
  }

  return candidate;
}

export function buildPasswordResetLink(
  token: string,
  options?: { mobile?: boolean; bridgeBaseUrl?: string | null },
): string {
  const query = `token=${encodeToken(token)}`;

  // Native-app resets point at the HTTPS bridge (Gmail-safe) which redirects
  // into the app's /reset-password screen. Falls back to the raw scheme only if
  // no reachable backend base is known. Web resets keep the web-app link.
  if (options?.mobile) {
    const bridgeBase = String(options.bridgeBaseUrl ?? '')
      .trim()
      .replace(/\/+$/, '');
    if (bridgeBase) {
      return `${bridgeBase}/auth/app-link/reset-password?${query}`;
    }
    // See `buildEmailVerificationLink`: a raw custom-scheme href is stripped by
    // email clients, leaving a button that renders and does nothing. Fall back
    // to the web link unless a real https universal link is configured.
    if (/^https?:\/\//i.test(String(process.env.MOBILE_APP_URL ?? '').trim())) {
      return `${resolveMobileAuthLinkBaseUrl()}reset-password?${query}`;
    }
    return `${resolveAuthLinkBaseUrl()}/reset-password?${query}`;
  }

  return `${resolveAuthLinkBaseUrl()}/reset-password?${query}`;
}

export function buildAdminPasswordResetLink(token: string): string {
  return `${resolveAuthLinkBaseUrl()}/admin/reset-password?token=${encodeToken(token)}`;
}

export function buildEmailVerificationLink(
  token: string,
  nextPath?: string | null,
  options?: { mobile?: boolean; bridgeBaseUrl?: string | null },
): string {
  const sanitizedNextPath = sanitizeAuthNextPath(nextPath);
  const nextQuery = sanitizedNextPath
    ? `&next=${encodeURIComponent(sanitizedNextPath)}`
    : '';
  const query = `token=${encodeToken(token)}${nextQuery}`;

  // Native-app signups point at the HTTPS bridge (Gmail-safe) which redirects
  // into the app's /verify-email screen. Falls back to the raw scheme only if
  // no reachable backend base is known. Web signups keep the web-app link.
  if (options?.mobile) {
    const bridgeBase = String(options.bridgeBaseUrl ?? '')
      .trim()
      .replace(/\/+$/, '');
    if (bridgeBase) {
      return `${bridgeBase}/auth/app-link/verify-email?${query}`;
    }

    // No bridge configured. This used to fall back to the raw custom scheme
    // (`wiezmobile://verify-email?...`) — which is the one thing that can never
    // work in an email: Gmail and most clients strip a non-http(s) href and
    // leave the anchor behind, so the button renders perfectly and does nothing
    // when tapped. That is the "verification button is just text" report.
    //
    // The web link is the only safe fallback. It survives every client, and the
    // web verify-email page hands off to the app where it can. An explicitly
    // configured `MOBILE_APP_URL` is still honoured, since that is set only when
    // it is a real https universal link.
    const configuredMobileBase = String(process.env.MOBILE_APP_URL ?? '').trim();
    if (/^https?:\/\//i.test(configuredMobileBase)) {
      return `${resolveMobileAuthLinkBaseUrl()}verify-email?${query}`;
    }
    return `${resolveAuthLinkBaseUrl()}/verify-email?${query}`;
  }

  return `${resolveAuthLinkBaseUrl()}/verify-email?${query}`;
}

export function buildEmailChangeConfirmationLink(token: string): string {
  return `${resolveAuthLinkBaseUrl()}/change-email/confirm?token=${encodeToken(token)}`;
}

function escapeHtmlAttr(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Android `intent://` form of a custom-scheme link. Chrome (and every Gmail /
 * WebView surface built on it) refuses to navigate a bare `wiezmobile://` href
 * — the tap is swallowed and nothing at all happens. An intent URL is the
 * supported way to say the same thing, and it carries its own
 * `browser_fallback_url` so a device without the app installed lands on the web
 * page instead of a dead end.
 */
function buildAndroidIntentUrl(schemeUrl: string, fallbackUrl: string): string {
  const withoutScheme = schemeUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const scheme = (schemeUrl.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1] ??
    'wiezmobile') as string;
  return `intent://${withoutScheme}#Intent;scheme=${scheme};S.browser_fallback_url=${encodeURIComponent(
    fallbackUrl,
  )};end`;
}

/**
 * HTML served by the backend "open in app" bridge. The auth email links here
 * over https (which Gmail keeps), and this page hands off to the native app.
 *
 * **The visible button is the web link, not the app scheme.** It used to be the
 * other way round, and that is the "verification button is not clickable"
 * report: a `<a href="wiezmobile://…">` is a no-op in Chrome and in the Gmail
 * in-app browser, so the one button on the page did nothing when tapped. The
 * app hand-off still happens — automatically, and via the secondary control —
 * but it can no longer be the only way out of this page.
 *
 * Hand-off strategy, in order:
 *   1. On load, try the app (intent URL on Android, custom scheme elsewhere).
 *   2. If the page is still visible ~1.4s later the app did not take over, so
 *      go to the web page, which completes the same action in the browser.
 *   3. Whatever happens, a real https button is on screen the whole time.
 */
export function buildAppLinkBridgeHtml(
  route: 'verify-email' | 'reset-password',
  params: { token: string; next?: string | null },
): string {
  const schemeUrl = buildMobileSchemeAuthLink(route, params.token, params.next);
  const webUrl =
    route === 'verify-email'
      ? buildEmailVerificationLink(params.token, params.next)
      : buildPasswordResetLink(params.token);
  const title =
    route === 'verify-email' ? 'Confirm your email' : 'Reset your password';
  const primaryLabel =
    route === 'verify-email' ? 'Confirm my email' : 'Reset my password';
  const intentUrl = buildAndroidIntentUrl(schemeUrl, webUrl);
  const webAttr = escapeHtmlAttr(webUrl);
  const schemeJson = JSON.stringify(schemeUrl);
  const intentJson = JSON.stringify(intentUrl);
  const webJson = JSON.stringify(webUrl);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>WIEZ — ${title}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0f0a14; color:#fff; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px; }
  .card { max-width:420px; width:100%; text-align:center; }
  .logo { font-size:30px; font-weight:800; letter-spacing:3px; color:#a855f7; margin-bottom:8px; }
  h1 { font-size:20px; margin:8px 0; }
  p { color:#b8b0c2; font-size:14px; line-height:1.5; }
  .btn { display:block; margin:20px auto 0; padding:15px 28px; background:#a855f7; color:#fff; text-decoration:none; border-radius:14px; font-weight:700; letter-spacing:0.5px; font-size:15px; }
  .alt { display:inline-block; margin-top:16px; padding:10px 14px; color:#c4b5fd; font-size:13px; text-decoration:underline; background:none; border:0; font-family:inherit; cursor:pointer; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">WIEZ</div>
    <h1>${title}</h1>
    <p>We are opening the WIEZ app. If it does not open, use the button below — it works right here in your browser.</p>
    <a class="btn" href="${webAttr}">${primaryLabel}</a>
    <button class="alt" type="button" id="open-app">Open in the WIEZ app instead</button>
  </div>
  <script>
    (function () {
      var scheme = ${schemeJson};
      var intent = ${intentJson};
      var web = ${webJson};
      var isAndroid = /android/i.test(navigator.userAgent || '');
      var appTarget = isAndroid ? intent : scheme;

      function openApp() {
        try { window.location.href = appTarget; } catch (e) {}
      }

      document.getElementById('open-app').addEventListener('click', openApp);

      openApp();

      // The app taking over backgrounds this page. If we are still visible, it
      // did not — finish the job on the web rather than stranding the user.
      setTimeout(function () {
        if (document.hidden || document.visibilityState === 'hidden') return;
        window.location.replace(web);
      }, 1400);
    })();
  </script>
</body>
</html>`;
}
