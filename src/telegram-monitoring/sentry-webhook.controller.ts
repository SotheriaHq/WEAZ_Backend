import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { IsPublic } from 'src/auth/decorator/is-public.decorator';
import { stableId } from './monitoring-keys';
import {
  parseSentryWebhook,
  verifySentrySignature,
} from './sentry-alert.parser';
import { SentryAlertHandler } from './sentry-alert.handler';
import { describe } from './telegram-delivery.service';
import { TelegramEventsService } from './telegram-events.service';
import { TelegramMonitoringConfig } from './telegram-monitoring.config';

/** Sentry signs the body, not the timestamp; this bounds replay of a captured request. */
const MAX_TIMESTAMP_SKEW_SECONDS = 10 * 60;

const header = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Receiver for a Sentry INTERNAL INTEGRATION (Settings → Developer Settings →
 * Custom Integrations) with "Alert Rule Action" enabled, so alert rules can
 * target it. Public (Sentry has no JWT) but fail-closed: without a configured
 * client secret, or with a signature that does not verify, nothing is parsed,
 * queued or sent. The destination chat is never taken from the request.
 */
@IsPublic()
@ApiExcludeController()
@Controller('webhooks/sentry')
export class SentryWebhookController {
  private readonly logger = new Logger(SentryWebhookController.name);

  constructor(
    private readonly config: TelegramMonitoringConfig,
    private readonly events: TelegramEventsService,
    private readonly handler: SentryAlertHandler,
  ) {}

  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async receive(
    @Body() body: unknown,
    @Req() req: Request & { rawBody?: string },
  ) {
    const secret = this.config.sentryWebhookSecret;
    if (!secret) {
      throw new ServiceUnavailableException(
        'Sentry webhook receiver is not configured',
      );
    }

    const verified = verifySentrySignature({
      secret,
      signature: header(req, 'sentry-hook-signature'),
      rawBody: req.rawBody,
      parsedBody: body,
    });
    if (!verified) {
      this.events.count('sentry.rejected_signature');
      this.logger.warn(
        `Rejected Sentry webhook with invalid signature from ${req.ip ?? 'unknown'}`,
      );
      throw new UnauthorizedException('Invalid signature');
    }

    const timestamp = Number(header(req, 'sentry-hook-timestamp'));
    if (Number.isFinite(timestamp) && timestamp > 0) {
      const skew = Math.abs(Date.now() / 1000 - timestamp);
      if (skew > MAX_TIMESTAMP_SKEW_SECONDS) {
        this.events.count('sentry.rejected_stale');
        throw new UnauthorizedException('Stale webhook');
      }
    }

    const resource = String(header(req, 'sentry-hook-resource') ?? '').trim();
    if (!this.config.isActive())
      return { status: 'ignored', reason: 'monitoring inactive' };

    const alert = parseSentryWebhook(resource, body);
    if (!alert) {
      // installation, comment, etc.: acknowledged, nothing to forward.
      return { status: 'ignored', reason: `resource ${resource || 'unknown'}` };
    }
    if (!this.handler.belongsHere(alert)) {
      this.events.count('sentry.ignored');
      return { status: 'ignored', reason: 'environment not forwarded' };
    }

    this.events.count('sentry.alert');
    // Sentry sends a unique Request-ID per delivery; retries of one delivery
    // reuse it. Fall back to a hash of the signed body.
    const deliveryId =
      header(req, 'request-id') ??
      stableId(resource, req.rawBody ?? JSON.stringify(body ?? {}));
    try {
      await this.events.enqueueSentryAlert(alert, `${resource}:${deliveryId}`);
    } catch (error) {
      this.logger.error(`Sentry alert could not be queued: ${describe(error)}`);
      throw new ServiceUnavailableException('Alert not queued');
    }
    return { status: 'queued' };
  }
}
