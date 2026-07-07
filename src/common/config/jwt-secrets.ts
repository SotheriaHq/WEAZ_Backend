import { ConfigService } from '@nestjs/config';

/**
 * Supports zero-downtime JWT rotation via JWT_ACCESS_SECRET_PREVIOUS.
 * Signing always uses the current secret; verification accepts current or previous.
 */
export function getJwtSigningSecret(config: ConfigService): string {
  const secret = config.get<string>('JWT_ACCESS_SECRET')?.trim();
  if (!secret) {
    throw new Error('JWT_ACCESS_SECRET must be configured');
  }
  return secret;
}

export function getJwtVerificationSecrets(config: ConfigService): string[] {
  const current = config.get<string>('JWT_ACCESS_SECRET')?.trim();
  const previous = config.get<string>('JWT_ACCESS_SECRET_PREVIOUS')?.trim();
  const secrets = [current, previous].filter(
    (value): value is string => Boolean(value && value.length > 0),
  );
  if (secrets.length === 0) {
    throw new Error('JWT_ACCESS_SECRET must be configured');
  }
  return Array.from(new Set(secrets));
}