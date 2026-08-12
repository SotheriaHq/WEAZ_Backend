const NON_LOCAL_ENV_MARKERS = new Set([
  'qa',
  'sit',
  'uat',
  'staging',
  'production',
  'prod',
]);

const DEFAULT_LOCAL_WEB_APP_HOST = 'localhost';
const DEFAULT_LOCAL_WEB_APP_PORT = '3000';

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function isEnabled(value: string | undefined): boolean {
  return (
    String(value ?? '')
      .trim()
      .toLowerCase() === 'true'
  );
}

function resolveEnvironmentMarker(): string {
  return String(
    process.env.APP_ENV ?? process.env.DEPLOY_ENV ?? process.env.NODE_ENV ?? '',
  )
    .trim()
    .toLowerCase();
}

export function isNonLocalEnvironment(): boolean {
  return NON_LOCAL_ENV_MARKERS.has(resolveEnvironmentMarker());
}

function isConfiguredWebAppUrl(value: string | undefined): boolean {
  const trimmed = stripSurroundingQuotes(value);
  if (!trimmed) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  // Treat template placeholders from env files as "not configured".
  if (lower.includes('<') || lower.includes('replace_me')) {
    return false;
  }

  // Must be an absolute http(s) URL. This is the base every auth email link
  // ultimately falls back to, so a malformed value here produces an href no
  // mail client will follow — a button that renders and does nothing. Rejecting
  // it means a non-local environment throws below (loud) instead of shipping
  // dead links (silent).
  if (!/^https?:\/\/[^/\s]+/i.test(trimmed)) {
    return false;
  }

  return true;
}

/**
 * `.env` parsers keep the quotes when a value is written `KEY="value"`, and a
 * leading `"` fails every scheme test downstream.
 */
function stripSurroundingQuotes(value: string | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

function resolveLocalWebAppBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const protocol = isEnabled(env.WEB_APP_USE_HTTPS) ? 'https' : 'http';
  const host =
    String(env.WEB_APP_HOST ?? DEFAULT_LOCAL_WEB_APP_HOST).trim() ||
    DEFAULT_LOCAL_WEB_APP_HOST;
  const port =
    String(env.WEB_APP_PORT ?? DEFAULT_LOCAL_WEB_APP_PORT).trim() ||
    DEFAULT_LOCAL_WEB_APP_PORT;
  return `${protocol}://${host}:${port}`;
}

export function resolveWebAppBaseUrl(): string {
  const configuredBaseUrl = [
    process.env.WEB_APP_URL,
    process.env.FRONTEND_URL,
  ].find(isConfiguredWebAppUrl);

  if (configuredBaseUrl) {
    return normalizeBaseUrl(stripSurroundingQuotes(configuredBaseUrl));
  }

  if (!isNonLocalEnvironment()) {
    return resolveLocalWebAppBaseUrl();
  }

  const marker = resolveEnvironmentMarker() || 'unknown';
  throw new Error(
    `WEB_APP_URL (or FRONTEND_URL) must be configured for non-local environments (detected: ${marker}).`,
  );
}
