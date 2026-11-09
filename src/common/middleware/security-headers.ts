import type { IncomingHttpHeaders } from 'http';

/**
 * One set of response security headers for everything the API answers.
 *
 * The Express middleware in `main.ts` only sees requests that reach Express.
 * Socket.IO's transport (Engine.IO) answers `/socket.io/` on the raw HTTP
 * server before Express runs, so those responses went out with none of these
 * headers — the ZAP scan of SIT flagged them for clickjacking, MIME sniffing,
 * HSTS and CSP. `EventsGateway` now applies the same set through Engine.IO's
 * `headers` hook, so both paths come from this one list.
 */

export const STRICT_TRANSPORT_SECURITY =
  'max-age=31536000; includeSubDomains; preload';

/**
 * The transport serves no documents, so nothing may load or frame it. Kept off
 * the Express routes on purpose: those include the Swagger page, which needs
 * scripts and styles.
 */
export const REALTIME_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'";

const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

type RequestLike = {
  headers: IncomingHttpHeaders;
  /** Express sets this (honouring `trust proxy`); a raw Node request does not. */
  secure?: boolean;
  /** A `tls.TLSSocket` carries `encrypted: true`; a plain `net.Socket` has no such field. */
  socket?: unknown;
};

/**
 * True when the client reached us over HTTPS: directly over TLS, or through
 * the TLS-terminating proxy in front of the API (`X-Forwarded-Proto`).
 *
 * The forwarded header is read even without `trust proxy`, as the existing
 * HSTS middleware already did. A forged value can only make the response
 * stricter (HSTS, Secure cookies), never weaker.
 */
export function isHttpsRequest(req: RequestLike | null | undefined): boolean {
  if (!req) return false;
  if (req.secure === true) return true;
  if (
    (req.socket as { encrypted?: unknown } | null | undefined)?.encrypted ===
    true
  ) {
    return true;
  }
  const raw = req.headers?.['x-forwarded-proto'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const first = value?.split(',')[0]?.trim().toLowerCase();
  return first === 'https';
}

export function securityHeadersFor(
  req: RequestLike | null | undefined,
  options: { contentSecurityPolicy?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = { ...BASE_SECURITY_HEADERS };
  if (options.contentSecurityPolicy) {
    headers['Content-Security-Policy'] = options.contentSecurityPolicy;
  }
  if (isHttpsRequest(req)) {
    headers['Strict-Transport-Security'] = STRICT_TRANSPORT_SECURITY;
  }
  return headers;
}

/** Engine.IO's `headers` event hands over a mutable header map. */
export function applyRealtimeSecurityHeaders(
  headers: Record<string, unknown>,
  req: RequestLike | null | undefined,
): void {
  Object.assign(
    headers,
    securityHeadersFor(req, {
      contentSecurityPolicy: REALTIME_CONTENT_SECURITY_POLICY,
    }),
  );
}
