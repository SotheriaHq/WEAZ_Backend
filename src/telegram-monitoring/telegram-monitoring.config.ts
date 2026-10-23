import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
// Private chats are positive ids, groups/channels negative (-100…). Anything
// else is a misconfiguration, never "a destination we can try".
const CHAT_ID_PATTERN = /^-?\d{5,20}$/;
const BOT_TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const ENV_LABEL_PATTERN = /^[A-Za-z0-9_-]{2,16}$/;

export type TelegramConfigProblem =
  | 'disabled'
  | 'missing_token'
  | 'malformed_token'
  | 'missing_chat_id'
  | 'malformed_chat_id'
  | 'malformed_environment';

/**
 * Single source of truth for monitoring configuration.
 *
 * The destination chat comes ONLY from TELEGRAM_ADMIN_CHAT_ID. No method in
 * this module accepts a chat id from a caller, so there is no code path where a
 * request payload, a Sentry webhook or a queue job can redirect a message:
 * that is the allowlist.
 */
@Injectable()
export class TelegramMonitoringConfig {
  constructor(private readonly config: ConfigService) {}

  private read(key: string): string {
    return String(
      this.config.get<string>(key) ?? process.env[key] ?? '',
    ).trim();
  }

  private flag(key: string, fallback: boolean): boolean {
    const raw = this.read(key).toLowerCase();
    if (!raw) return fallback;
    return TRUE_VALUES.has(raw);
  }

  get enabled(): boolean {
    return this.flag('TELEGRAM_MONITORING_ENABLED', false);
  }

  get botToken(): string {
    return this.read('TELEGRAM_BOT_TOKEN');
  }

  get chatId(): string {
    return this.read('TELEGRAM_ADMIN_CHAT_ID');
  }

  /** Short label printed on every message, e.g. SIT / UAT / PROD. */
  get environment(): string {
    const label =
      this.read('TELEGRAM_ENVIRONMENT') || this.read('APP_ENV') || 'UNKNOWN';
    return label.toUpperCase();
  }

  /**
   * Owner decision (2026-10-22, SIT): user-activity alerts carry username,
   * email and user id. Off unless explicitly enabled so a new environment
   * never starts shipping personal data to Telegram by default.
   */
  get includeUserIdentity(): boolean {
    return this.flag('TELEGRAM_INCLUDE_USER_IDENTITY', false);
  }

  get reportsEnabled(): boolean {
    return this.flag('TELEGRAM_REPORTS_ENABLED', true);
  }

  get reportTimeZone(): string {
    return this.read('TELEGRAM_REPORT_TIMEZONE') || 'Africa/Lagos';
  }

  get sentryWebhookSecret(): string {
    return this.read('SENTRY_WEBHOOK_CLIENT_SECRET');
  }

  get sentryApiToken(): string {
    return this.read('SENTRY_API_TOKEN');
  }

  get sentryOrgSlug(): string {
    return this.read('SENTRY_ORG_SLUG');
  }

  get sentryApiBaseUrl(): string {
    const raw = this.read('SENTRY_API_BASE_URL') || 'https://sentry.io';
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' ? url.origin : 'https://sentry.io';
    } catch {
      return 'https://sentry.io';
    }
  }

  /**
   * Sentry environments whose alerts this deployment forwards. One Sentry
   * project can receive SIT and production events; without this filter a
   * production incident would page the SIT bot.
   */
  get sentryAlertEnvironments(): string[] {
    const raw =
      this.read('SENTRY_ALERT_ENVIRONMENTS') ||
      this.read('SENTRY_ENVIRONMENT') ||
      this.read('APP_ENV');
    return raw
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }

  get healthcheckUrl(): string {
    const explicit = this.read('TELEGRAM_HEALTHCHECK_URL');
    if (explicit) return explicit;
    const port = this.read('APP_PORT') || this.read('PORT') || '3040';
    return `http://127.0.0.1:${port}/healthz`;
  }

  problems(): TelegramConfigProblem[] {
    const problems: TelegramConfigProblem[] = [];
    if (!this.enabled) problems.push('disabled');
    if (!this.botToken) problems.push('missing_token');
    else if (!BOT_TOKEN_PATTERN.test(this.botToken))
      problems.push('malformed_token');
    if (!this.chatId) problems.push('missing_chat_id');
    else if (!CHAT_ID_PATTERN.test(this.chatId))
      problems.push('malformed_chat_id');
    if (!ENV_LABEL_PATTERN.test(this.environment))
      problems.push('malformed_environment');
    return problems;
  }

  /** True only when enabled AND every credential is well-formed. */
  isActive(): boolean {
    return this.problems().length === 0;
  }
}
