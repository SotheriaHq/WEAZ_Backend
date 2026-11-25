/** Every default this code ever shipped. Historical values: never rename them. */
export const LEGACY_VERIFICATION_DRAFT_SECRETS: readonly string[] = [
  'threadly-verification-draft-secret',
  'wiez-verification-draft-secret',
];
const MIN_SECRET_LENGTH = 32;

function isProduction(config: Record<string, unknown>): boolean {
  return (
    String(config.NODE_ENV ?? process.env.NODE_ENV ?? '')
      .trim()
      .toLowerCase() === 'production'
  );
}

function boolFlag(value: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );
}

function assertStrongSecret(
  config: Record<string, unknown>,
  key: string,
  options?: { disallow?: readonly string[] },
): void {
  const value = String(config[key] ?? '').trim();
  // Named before length, so a short legacy value is still reported as legacy.
  if (options?.disallow?.includes(value)) {
    throw new Error(`${key} uses an unsafe legacy value.`);
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${key} must be configured with at least ${MIN_SECRET_LENGTH} characters in production.`,
    );
  }
}

export function validateProductionSecurityEnv(
  config: Record<string, unknown>,
): void {
  if (!isProduction(config)) return;

  assertStrongSecret(config, 'VERIFICATION_DRAFT_SECRET', {
    disallow: LEGACY_VERIFICATION_DRAFT_SECRETS,
  });

  if (boolFlag(config.BREAK_GLASS_ENABLED)) {
    if (!boolFlag(config.BREAK_GLASS_PRODUCTION_ENABLED)) {
      throw new Error(
        'BREAK_GLASS_PRODUCTION_ENABLED=true is required to enable break-glass in production.',
      );
    }
    assertStrongSecret(config, 'BREAK_GLASS_JWT_SECRET');
    if (!String(config.BREAK_GLASS_RECOVERY_EMAIL ?? '').trim()) {
      throw new Error(
        'BREAK_GLASS_RECOVERY_EMAIL must be configured when production break-glass is enabled.',
      );
    }
  }
}
