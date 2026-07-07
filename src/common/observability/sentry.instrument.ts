import * as Sentry from '@sentry/nestjs';

let sentryInitialised = false;

const parseSampleRate = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function initSentry(): void {
  if (sentryInitialised) {
    return;
  }

  const dsn = String(process.env.SENTRY_DSN ?? '').trim();
  if (!dsn) {
    return;
  }

  const environment =
    String(process.env.SENTRY_ENVIRONMENT ?? process.env.APP_ENV ?? 'development').trim() ||
    'development';
  const release =
    String(process.env.SENTRY_RELEASE ?? process.env.GIT_SHA ?? '').trim() || undefined;
  const tracesSampleRate = parseSampleRate(
    process.env.SENTRY_TRACES_SAMPLE_RATE,
    0.1,
  );
  const profileSessionSampleRate = parseSampleRate(
    process.env.SENTRY_PROFILES_SAMPLE_RATE,
    0,
  );
  const enableProfiling =
    String(process.env.SENTRY_PROFILING_ENABLED ?? '').trim().toLowerCase() ===
      'true' || profileSessionSampleRate > 0;

  const integrations: Parameters<typeof Sentry.init>[0]['integrations'] = [];
  if (enableProfiling) {
    try {
      // Optional: install @sentry/profiling-node when profiling is enabled in env.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { nodeProfilingIntegration } = require('@sentry/profiling-node');
      integrations.push(nodeProfilingIntegration());
    } catch {
      // Profiling package not installed; tracing still works.
    }
  }

  Sentry.init({
    dsn,
    environment,
    release,
    integrations: integrations.length > 0 ? integrations : undefined,
    enableLogs: String(process.env.SENTRY_ENABLE_LOGS ?? 'true').trim() !== 'false',
    tracesSampleRate,
    profileSessionSampleRate: enableProfiling ? profileSessionSampleRate : 0,
    profileLifecycle: enableProfiling ? 'trace' : undefined,
    sendDefaultPii: false,
  });

  sentryInitialised = true;
}

export function isSentryEnabled(): boolean {
  return sentryInitialised;
}