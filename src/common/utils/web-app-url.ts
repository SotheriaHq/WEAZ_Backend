const NON_LOCAL_ENV_MARKERS = new Set([
  'qa',
  'uat',
  'staging',
  'production',
  'prod',
]);

const LOCAL_DEV_WEB_APP_BASE_URL = 'http://localhost:3000';

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
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

export function resolveWebAppBaseUrl(): string {
  const configuredBaseUrl =
    String(process.env.WEB_APP_URL ?? '').trim() ||
    String(process.env.FRONTEND_URL ?? '').trim();

  if (configuredBaseUrl) {
    return normalizeBaseUrl(configuredBaseUrl);
  }

  if (!isNonLocalEnvironment()) {
    return LOCAL_DEV_WEB_APP_BASE_URL;
  }

  throw new Error(
    'WEB_APP_URL (or FRONTEND_URL) must be configured for non-local environments.',
  );
}
