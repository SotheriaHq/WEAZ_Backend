import { resolveWebAppBaseUrl } from './web-app-url';

function resolveAuthLinkBaseUrl(): string {
  return resolveWebAppBaseUrl().replace(/\/+$/, '');
}

/**
 * Base for deep links that should open the native app instead of the web app.
 * Defaults to the Expo custom scheme (`weazmobile://`) so a verification link
 * tapped on a phone launches the installed app and lands on `/verify-email`.
 * Override with `MOBILE_APP_URL` for a universal/https link once a verified
 * associated domain is hosted. Always returned with a trailing slash so a path
 * can be appended directly.
 */
function resolveMobileAuthLinkBaseUrl(): string {
  const configured = String(process.env.MOBILE_APP_URL ?? '').trim();
  const base = configured || 'weazmobile://';
  return base.endsWith('/') ? base : `${base}/`;
}

/**
 * Public, reachable base URL of THIS backend, used for the HTTPS "open in app"
 * bridge links in auth emails. Gmail (and most clients) strip raw custom-scheme
 * (`weazmobile://`) links, so the email must contain an https/http link the
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
 * Raw custom-scheme deep link (e.g. `weazmobile://verify-email?token=...`). Used
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
    return `${resolveMobileAuthLinkBaseUrl()}reset-password?${query}`;
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
    return `${resolveMobileAuthLinkBaseUrl()}verify-email?${query}`;
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
 * HTML served by the backend "open in app" bridge. The auth email links here
 * over https (which Gmail keeps), and this page immediately redirects into the
 * app's custom scheme — with a manual button + a web fallback for desktop /
 * browsers that block the scheme redirect.
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
  const schemeAttr = escapeHtmlAttr(schemeUrl);
  const webAttr = escapeHtmlAttr(webUrl);
  const schemeJson = JSON.stringify(schemeUrl);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>WEAZ — ${title}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0f0a14; color:#fff; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px; }
  .card { max-width:420px; width:100%; text-align:center; }
  .logo { font-size:30px; font-weight:800; letter-spacing:3px; color:#a855f7; margin-bottom:8px; }
  h1 { font-size:20px; margin:8px 0; }
  p { color:#b8b0c2; font-size:14px; line-height:1.5; }
  .btn { display:inline-block; margin-top:20px; padding:14px 28px; background:#a855f7; color:#fff; text-decoration:none; border-radius:14px; font-weight:700; letter-spacing:1px; }
  .alt { display:block; margin-top:16px; color:#a855f7; font-size:13px; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">WEAZ</div>
    <h1>Opening the WEAZ app…</h1>
    <p>If the app doesn’t open automatically, tap the button below.</p>
    <a class="btn" href="${schemeAttr}">Open in WEAZ</a>
    <a class="alt" href="${webAttr}">Continue on the web instead</a>
  </div>
  <script>
    (function () {
      var target = ${schemeJson};
      window.location.replace(target);
      setTimeout(function () { try { window.location.href = target; } catch (e) {} }, 350);
    })();
  </script>
</body>
</html>`;
}
