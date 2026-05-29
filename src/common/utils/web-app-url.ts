const NON_LOCAL_ENV_MARKERS = new Set([
  'qa',
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
  const configuredBaseUrl =
    String(process.env.WEB_APP_URL ?? '').trim() ||
    String(process.env.FRONTEND_URL ?? '').trim();

  if (configuredBaseUrl) {
    return normalizeBaseUrl(configuredBaseUrl);
  }

  if (!isNonLocalEnvironment()) {
    return resolveLocalWebAppBaseUrl();
  }

  throw new Error(
    'WEB_APP_URL (or FRONTEND_URL) must be configured for non-local environments.',
  );
}
