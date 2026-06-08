import type { ConfigService } from '@nestjs/config';
import { PRODUCT_NAME } from '../common/branding/product-identity.constants';

export type EmailProvider = 'mailjet' | 'smtp' | 'console';

export type ResolvedEmailConfig = {
  provider: EmailProvider;
  appName: string;
  fromAddress: string;
  fromName: string;
  replyTo: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpPass: string | null;
  transportEnabled: boolean;
  deliveryProviderName: string;
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
const DEFAULT_FROM_ADDRESS = 'noreply@threadly.app';
const DEFAULT_MAILJET_SMTP_HOST = 'in-v3.mailjet.com';
const DEFAULT_MAILJET_SMTP_PORT = 587;
const MAILJET_SMTP_HOST_ALIASES = new Set([
  'in-v3.mailjet.com',
  'smtp.mailjet.com',
]);

const cleanString = (value: string | undefined | null): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parsePort = (value: string | undefined | null): number | null => {
  const cleaned = cleanString(value);
  if (!cleaned) {
    return null;
  }

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
};

const normalizeProvider = (value: string | null): EmailProvider | null => {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'mailjet' ||
    normalized === 'smtp' ||
    normalized === 'console'
  ) {
    return normalized;
  }

  return null;
};

const inferEmailProvider = (config: ConfigService): EmailProvider => {
  const explicitProvider = normalizeProvider(
    cleanString(
      config.get<string>('EMAIL_PROVIDER') ??
        config.get<string>('MAILER_PROVIDER'),
    ),
  );
  if (explicitProvider) {
    return explicitProvider;
  }

  const mailjetSignals = [
    cleanString(config.get<string>('MAILJET_API_KEY')),
    cleanString(config.get<string>('MAILJET_SECRET_KEY')),
    cleanString(config.get<string>('MAILJET_SMTP_HOST')),
  ];
  if (mailjetSignals.some(Boolean)) {
    return 'mailjet';
  }

  const legacyHost = cleanString(config.get<string>('SMTP_HOST'));
  if (legacyHost && MAILJET_SMTP_HOST_ALIASES.has(legacyHost.toLowerCase())) {
    return 'mailjet';
  }

  const smtpSignals = [
    legacyHost,
    cleanString(config.get<string>('SMTP_USER')),
    cleanString(config.get<string>('SMTP_PASS')),
  ];
  if (smtpSignals.some(Boolean)) {
    return 'smtp';
  }

  return 'console';
};

export const resolveEmailConfig = (
  config: ConfigService,
): ResolvedEmailConfig => {
  const provider = inferEmailProvider(config);
  const warnings: string[] = [];

  const appName =
    cleanString(config.get<string>('APP_NAME')) ?? DEFAULT_APP_NAME;
  const fromAddress =
    cleanString(config.get<string>('MAIL_FROM_ADDRESS')) ??
    cleanString(config.get<string>('DEFAULT_MAILER')) ??
    DEFAULT_FROM_ADDRESS;
  const fromName = cleanString(config.get<string>('MAIL_FROM_NAME')) ?? appName;
  const replyTo = cleanString(config.get<string>('MAIL_REPLY_TO'));

  let smtpHost: string | null = null;
  let smtpPort: number | null = null;
  let smtpUser: string | null = null;
  let smtpPass: string | null = null;
  let deliveryProviderName = 'CONSOLE';
  let webhookSharedSecret: string | null = null;
  let webhookBasicUser: string | null = null;
  let webhookBasicPass: string | null = null;

  if (provider === 'mailjet') {
    smtpHost =
      cleanString(config.get<string>('MAILJET_SMTP_HOST')) ??
      cleanString(config.get<string>('SMTP_HOST')) ??
      DEFAULT_MAILJET_SMTP_HOST;
    smtpPort =
      parsePort(config.get<string>('MAILJET_SMTP_PORT')) ??
      parsePort(config.get<string>('SMTP_PORT')) ??
      DEFAULT_MAILJET_SMTP_PORT;
    smtpUser =
      cleanString(config.get<string>('MAILJET_API_KEY')) ??
      cleanString(config.get<string>('SMTP_USER'));
    smtpPass =
      cleanString(config.get<string>('MAILJET_SECRET_KEY')) ??
      cleanString(config.get<string>('SMTP_PASS'));
    deliveryProviderName = 'MAILJET_API';
    webhookSharedSecret =
      cleanString(config.get<string>('MAILJET_WEBHOOK_SECRET')) ??
      cleanString(config.get<string>('EMAIL_WEBHOOK_SECRET_MAILJET')) ??
      cleanString(config.get<string>('EMAIL_WEBHOOK_SECRET'));
    webhookBasicUser =
      cleanString(config.get<string>('MAILJET_WEBHOOK_BASIC_USER')) ??
      cleanString(config.get<string>('EMAIL_WEBHOOK_BASIC_USER_MAILJET')) ??
      cleanString(config.get<string>('EMAIL_WEBHOOK_BASIC_USER'));
    webhookBasicPass =
      cleanString(config.get<string>('MAILJET_WEBHOOK_BASIC_PASS')) ??
      cleanString(config.get<string>('EMAIL_WEBHOOK_BASIC_PASS_MAILJET')) ??
      cleanString(config.get<string>('EMAIL_WEBHOOK_BASIC_PASS'));

    if (
      smtpHost &&
      !MAILJET_SMTP_HOST_ALIASES.has(smtpHost.trim().toLowerCase())
    ) {
      warnings.push(
        `Mailjet SMTP host is "${smtpHost}". Official Mailjet SMTP relay is "${DEFAULT_MAILJET_SMTP_HOST}".`,
      );
    }

    if (cleanString(config.get<string>('DEFAULT_MAILER'))) {
      warnings.push(
        'DEFAULT_MAILER is deprecated for Mailjet config. Use MAIL_FROM_ADDRESS instead.',
      );
    }

    if (
      cleanString(config.get<string>('SMTP_HOST')) ||
      cleanString(config.get<string>('SMTP_PORT')) ||
      cleanString(config.get<string>('SMTP_USER')) ||
      cleanString(config.get<string>('SMTP_PASS'))
    ) {
      warnings.push(
        'Legacy SMTP_* keys are deprecated for Mailjet config. Use MAILJET_SMTP_HOST, MAILJET_SMTP_PORT, MAILJET_API_KEY, and MAILJET_SECRET_KEY.',
      );
    }

    const senderDomain = fromAddress.split('@')[1]?.trim().toLowerCase() ?? '';
    if (senderDomain.startsWith('mg.')) {
      warnings.push(
        `MAIL_FROM_ADDRESS uses "${senderDomain}". If that subdomain is still authenticated for Mailgun instead of Mailjet, inbox delivery can fail even when Mailjet accepts the message.`,
      );
    }
  } else if (provider === 'smtp') {
    smtpHost = cleanString(config.get<string>('SMTP_HOST'));
    smtpPort = parsePort(config.get<string>('SMTP_PORT')) ?? 587;
    smtpUser = cleanString(config.get<string>('SMTP_USER'));
    smtpPass = cleanString(config.get<string>('SMTP_PASS'));
    deliveryProviderName = 'SMTP';
    webhookSharedSecret = cleanString(
      config.get<string>('EMAIL_WEBHOOK_SECRET'),
    );
    webhookBasicUser = cleanString(
      config.get<string>('EMAIL_WEBHOOK_BASIC_USER'),
    );
    webhookBasicPass = cleanString(
      config.get<string>('EMAIL_WEBHOOK_BASIC_PASS'),
    );
  } else {
    webhookSharedSecret = cleanString(
      config.get<string>('EMAIL_WEBHOOK_SECRET'),
    );
    webhookBasicUser = cleanString(
      config.get<string>('EMAIL_WEBHOOK_BASIC_USER'),
    );
    webhookBasicPass = cleanString(
      config.get<string>('EMAIL_WEBHOOK_BASIC_PASS'),
    );
  }

  if (!!webhookBasicUser !== !!webhookBasicPass) {
    warnings.push(
      'Email webhook basic auth requires both username and password. Configure both values or remove both.',
    );
  }

  if (
    provider === 'mailjet' &&
    !webhookSharedSecret &&
    !webhookBasicUser &&
    !webhookBasicPass
  ) {
    warnings.push(
      'Mailjet webhook authentication is not configured. Delivery outcomes (delivered, bounce, complaint) will not be tracked in real time.',
    );
  }

  return {
    provider,
    appName,
    fromAddress,
    fromName,
    replyTo,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    transportEnabled: !!smtpHost && !!smtpPort && !!smtpUser && !!smtpPass,
    deliveryProviderName,
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
  if (normalized === 'mailjet') {
    const mailjetConfig = resolveEmailConfig(config);
    return {
      sharedSecret: mailjetConfig.webhookSharedSecret,
      basicUser: mailjetConfig.webhookBasicUser,
      basicPass: mailjetConfig.webhookBasicPass,
    };
  }

  const providerKey = provider
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_');
  return {
    sharedSecret:
      cleanString(config.get<string>(`EMAIL_WEBHOOK_SECRET_${providerKey}`)) ??
      cleanString(config.get<string>('EMAIL_WEBHOOK_SECRET')),
    basicUser:
      cleanString(
        config.get<string>(`EMAIL_WEBHOOK_BASIC_USER_${providerKey}`),
      ) ?? cleanString(config.get<string>('EMAIL_WEBHOOK_BASIC_USER')),
    basicPass:
      cleanString(
        config.get<string>(`EMAIL_WEBHOOK_BASIC_PASS_${providerKey}`),
      ) ?? cleanString(config.get<string>('EMAIL_WEBHOOK_BASIC_PASS')),
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
