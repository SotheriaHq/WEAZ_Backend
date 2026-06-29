import type { ConfigService } from '@nestjs/config';
import { PRODUCT_NAME } from '../common/branding/product-identity.constants';

export type EmailProvider = 'resend';
export type EmailMode = 'log_only' | 'redirect' | 'live';

export type ResolvedEmailConfig = {
  provider: EmailProvider;
  mode: EmailMode;
  appName: string;
  resendApiKey: string | null;
  from: string | null;
  fromAddress: string | null;
  fromName: string;
  replyTo: string | null;
  redirectTo: string | null;
  dailyLimit: number | null;
  logIntendedRecipient: boolean;
  deliveryProviderName: string;
  transportHost: string | null;
  webhookSharedSecret: string | null;
  webhookBasicUser: string | null;
  webhookBasicPass: string | null;
  warnings: string[];
};

type WebhookAuthConfig = {
  sharedSecret: string | null;
  basicUser: string | null;
  basicPass: string | null;
};

const DEFAULT_APP_NAME = PRODUCT_NAME;
const RESEND_API_HOST = 'api.resend.com';

const cleanString = (value: string | undefined | null): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseBooleanEnvFlag = (
  value: string | undefined | null,
  fallback: boolean,
): boolean => {
  const cleaned = cleanString(value);
  if (!cleaned) {
    return fallback;
  }

  const normalized = cleaned.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
};

const parseDailyLimit = (
  value: string | undefined | null,
  warnings: string[],
): number | null => {
  const cleaned = cleanString(value);
  if (!cleaned) {
    return null;
  }

  const parsed = Number(cleaned);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    warnings.push(
      'EMAIL_DAILY_LIMIT must be a positive integer. Daily send limiting is disabled until this is corrected.',
    );
    return null;
  }

  return parsed;
};

const normalizeMode = (
  value: string | undefined | null,
  warnings: string[],
): EmailMode => {
  const normalized = cleanString(value)?.toLowerCase();
  if (
    normalized === 'log_only' ||
    normalized === 'redirect' ||
    normalized === 'live'
  ) {
    return normalized;
  }

  if (normalized) {
    warnings.push(
      `Invalid EMAIL_MODE="${normalized}". Falling back to safe log_only mode.`,
    );
  }

  return 'log_only';
};

const parseFromAddress = (from: string | null): string | null => {
  if (!from) {
    return null;
  }

  const displayNameMatch = from.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  if (displayNameMatch) {
    return displayNameMatch[1].trim().toLowerCase();
  }

  const bareAddressMatch = from.match(/^[^@\s<>]+@[^@\s<>]+$/);
  return bareAddressMatch ? from.trim().toLowerCase() : null;
};

const parseFromName = (from: string | null, fallback: string): string => {
  if (!from) {
    return fallback;
  }

  const displayNameMatch = from.match(/^"?([^"<]+?)"?\s*<[^<>]+>$/);
  const parsed = cleanString(displayNameMatch?.[1]);
  return parsed ?? fallback;
};

export const resolveEmailConfig = (
  config: ConfigService,
): ResolvedEmailConfig => {
  const warnings: string[] = [];
  const providerRaw = cleanString(config.get<string>('EMAIL_PROVIDER'));
  if (providerRaw && providerRaw.toLowerCase() !== 'resend') {
    warnings.push(
      `EMAIL_PROVIDER="${providerRaw}" is no longer supported. Active email delivery is Resend-only.`,
    );
  }

  const mode = normalizeMode(config.get<string>('EMAIL_MODE'), warnings);
  const appName =
    cleanString(config.get<string>('APP_NAME')) ?? DEFAULT_APP_NAME;
  const from = cleanString(config.get<string>('RESEND_FROM'));
  const fromAddress = parseFromAddress(from);
  const fromName = parseFromName(from, appName);
  const replyTo = cleanString(config.get<string>('RESEND_REPLY_TO'));
  const redirectTo = cleanString(config.get<string>('SIT_EMAIL_REDIRECT_TO'));
  const dailyLimit = parseDailyLimit(
    config.get<string>('EMAIL_DAILY_LIMIT'),
    warnings,
  );
  const logIntendedRecipient = parseBooleanEnvFlag(
    config.get<string>('EMAIL_LOG_INTENDED_RECIPIENT'),
    false,
  );
  const resendApiKey = cleanString(config.get<string>('RESEND_API_KEY'));

  if (from && !fromAddress) {
    warnings.push(
      'RESEND_FROM is configured but does not look like a valid email sender address.',
    );
  }

  if (mode === 'redirect' && !redirectTo) {
    warnings.push(
      'EMAIL_MODE=redirect requires SIT_EMAIL_REDIRECT_TO before email can be sent.',
    );
  }

  if ((mode === 'redirect' || mode === 'live') && !resendApiKey) {
    warnings.push(
      `EMAIL_MODE=${mode} requires RESEND_API_KEY before email can be sent.`,
    );
  }

  if ((mode === 'redirect' || mode === 'live') && !from) {
    warnings.push(
      `EMAIL_MODE=${mode} requires RESEND_FROM before email can be sent.`,
    );
  }

  const webhookSharedSecret =
    cleanString(config.get<string>('RESEND_WEBHOOK_SECRET')) ??
    cleanString(config.get<string>('EMAIL_WEBHOOK_SECRET_RESEND')) ??
    cleanString(config.get<string>('EMAIL_WEBHOOK_SECRET'));
  const webhookBasicUser =
    cleanString(config.get<string>('RESEND_WEBHOOK_BASIC_USER')) ??
    cleanString(config.get<string>('EMAIL_WEBHOOK_BASIC_USER_RESEND')) ??
    cleanString(config.get<string>('EMAIL_WEBHOOK_BASIC_USER'));
  const webhookBasicPass =
    cleanString(config.get<string>('RESEND_WEBHOOK_BASIC_PASS')) ??
    cleanString(config.get<string>('EMAIL_WEBHOOK_BASIC_PASS_RESEND')) ??
    cleanString(config.get<string>('EMAIL_WEBHOOK_BASIC_PASS'));

  if (!!webhookBasicUser !== !!webhookBasicPass) {
    warnings.push(
      'Resend email webhook basic auth requires both username and password. Configure both values or remove both.',
    );
  }

  return {
    provider: 'resend',
    mode,
    appName,
    resendApiKey,
    from,
    fromAddress,
    fromName,
    replyTo,
    redirectTo,
    dailyLimit,
    logIntendedRecipient,
    deliveryProviderName: mode === 'log_only' ? 'RESEND_LOG_ONLY' : 'RESEND',
    transportHost: mode === 'log_only' ? null : RESEND_API_HOST,
    webhookSharedSecret,
    webhookBasicUser,
    webhookBasicPass,
    warnings,
  };
};

export const resolveEmailWebhookAuth = (
  config: ConfigService,
  provider: string,
): WebhookAuthConfig => {
  const normalized = provider.trim().toLowerCase();
  if (normalized !== 'resend') {
    return {
      sharedSecret: null,
      basicUser: null,
      basicPass: null,
    };
  }

  const emailConfig = resolveEmailConfig(config);
  return {
    sharedSecret: emailConfig.webhookSharedSecret,
    basicUser: emailConfig.webhookBasicUser,
    basicPass: emailConfig.webhookBasicPass,
  };
};

export const parseBasicAuthHeader = (
  authorizationHeader: string | undefined,
): { username: string; password: string } | null => {
  if (!authorizationHeader) {
    return null;
  }

  const match = authorizationHeader.match(/^Basic\s+(.+)$/i);
  if (!match) {
    return null;
  }

  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
};
