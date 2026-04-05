const PAYSTACK_SECRET_ENV_KEYS = [
  'PAYSTACK_SECRET_KEY',
  'PAYSTACK_SECRET',
  'PAYSTACK_SECRET_API',
  'PAYSTACK_TEST_SECRET_API',
] as const;

export function resolvePaystackSecret(
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const key of PAYSTACK_SECRET_ENV_KEYS) {
    const candidate = String(env[key] ?? '').trim();
    if (candidate) {
      return candidate;
    }
  }

  return '';
}

export function describePaystackSecretEnvKeys(): string {
  return PAYSTACK_SECRET_ENV_KEYS.join(', ');
}
