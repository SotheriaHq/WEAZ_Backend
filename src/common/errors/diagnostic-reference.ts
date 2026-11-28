/**
 * The reference a person can quote to support so the matching server logs can
 * be found (WP-03 PR-A). It is the request id that requestLoggerMiddleware
 * already assigns, logs and returns in the `x-request-id` header.
 *
 * That id may come from the client, so only a short, plain token is echoed in
 * a response body; anything else is omitted rather than reflected.
 */
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

type RequestWithId = {
  requestId?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};

export function diagnosticReference(
  request: RequestWithId | null | undefined,
): string | undefined {
  if (!request) return undefined;
  const header = request.headers?.['x-request-id'];
  const candidate =
    request.requestId ?? (Array.isArray(header) ? header[0] : header);
  if (typeof candidate !== 'string') return undefined;
  const value = candidate.trim();
  return REFERENCE_PATTERN.test(value) ? value : undefined;
}
