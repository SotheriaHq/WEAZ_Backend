import { Injectable, Logger } from '@nestjs/common';
import { TelegramMonitoringConfig } from './telegram-monitoring.config';

const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 8_000;
/** Telegram rejects text over 4096 chars; leave room for the truncation marker. */
export const TELEGRAM_MAX_TEXT = 4_000;

export type TelegramFailureKind =
  /** Network error, timeout, Telegram 5xx: try again later. */
  | 'retryable'
  /** 429: wait `retryAfterSeconds`, then try again. */
  | 'rate_limited'
  /** Bad token, unknown chat, bot blocked, malformed request: retrying cannot help. */
  | 'fatal'
  /** Monitoring disabled or misconfigured: nothing was attempted. */
  | 'inactive';

export class TelegramDeliveryError extends Error {
  constructor(
    readonly kind: TelegramFailureKind,
    message: string,
    readonly retryAfterSeconds: number | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'TelegramDeliveryError';
  }
}

export type TelegramSendResult = { messageId: number };

/**
 * Minimal, outbound-only Telegram Bot API client.
 *
 * Deliberately not a framework: two endpoints (sendMessage, getMe), native
 * fetch, a hard timeout, and no polling or webhooks — the bot never reads
 * messages. The token lives only in the request URL; it is never interpolated
 * into an error, a log line or a return value.
 */
@Injectable()
export class TelegramClient {
  private readonly logger = new Logger(TelegramClient.name);

  constructor(private readonly config: TelegramMonitoringConfig) {}

  async sendMessage(text: string): Promise<TelegramSendResult> {
    this.assertActive();
    const body = {
      chat_id: this.config.chatId,
      text: truncateForTelegram(text),
      // Plain text on purpose: no parse_mode means user-controlled strings
      // (brand names, Sentry titles) can never inject markup or fake links.
      link_preview_options: { is_disabled: true },
    };
    const result = await this.call<{ message_id: number }>('sendMessage', body);
    return { messageId: Number(result?.message_id ?? 0) };
  }

  /** Validates the token without sending anything. */
  async getMe(): Promise<{ username: string; id: number }> {
    if (!this.config.botToken) {
      throw new TelegramDeliveryError('inactive', 'TELEGRAM_BOT_TOKEN is not set');
    }
    const result = await this.call<{ username?: string; id?: number }>('getMe');
    return { username: String(result?.username ?? ''), id: Number(result?.id ?? 0) };
  }

  private assertActive(): void {
    const problems = this.config.problems();
    if (problems.length > 0) {
      throw new TelegramDeliveryError(
        'inactive',
        `Telegram monitoring inactive: ${problems.join(', ')}`,
      );
    }
  }

  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${TELEGRAM_API_ORIGIN}/bot${this.config.botToken}/${method}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Never forward `error` itself: undici errors can embed the request URL.
      const name = error instanceof Error ? error.name : 'Error';
      throw new TelegramDeliveryError(
        'retryable',
        name === 'TimeoutError'
          ? `Telegram ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `Telegram ${method} network failure (${name})`,
      );
    }

    let payload: {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      payload = {};
    }

    if (response.ok && payload.ok) {
      return payload.result as T;
    }

    const status = response.status;
    const description = sanitizeDescription(payload.description);
    if (status === 429) {
      const retryAfter = Math.max(1, Number(payload.parameters?.retry_after ?? 5));
      throw new TelegramDeliveryError(
        'rate_limited',
        `Telegram ${method} rate limited; retry after ${retryAfter}s`,
        retryAfter,
        status,
      );
    }
    if (status >= 500) {
      throw new TelegramDeliveryError(
        'retryable',
        `Telegram ${method} server error ${status}: ${description}`,
        null,
        status,
      );
    }
    // 400 chat not found / 401 bad token / 403 bot blocked / 404 bad token path.
    this.logger.error(`Telegram ${method} rejected (${status}): ${description}`);
    throw new TelegramDeliveryError(
      'fatal',
      `Telegram ${method} rejected (${status}): ${description}`,
      null,
      status,
    );
  }
}

export function truncateForTelegram(text: string): string {
  const value = String(text ?? '');
  if (value.length <= TELEGRAM_MAX_TEXT) return value;
  return `${value.slice(0, TELEGRAM_MAX_TEXT - 20)}\n… (truncated)`;
}

function sanitizeDescription(value: unknown): string {
  // Telegram descriptions are short fixed strings, but strip anything that
  // looks like a bot token in case a proxy ever echoes the URL back.
  return String(value ?? 'no description')
    .replace(/\d{5,15}:[A-Za-z0-9_-]{30,64}/g, '<redacted>')
    .slice(0, 200);
}
