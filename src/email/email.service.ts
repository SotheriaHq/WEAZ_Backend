import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import {
  EmailOutboxStatus,
  EmailPriority,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  resolveEmailConfig,
  type EmailMode,
  type ResolvedEmailConfig,
} from './email.config';
import { maskEmailForLog } from 'src/common/utils/sensitive-log';

export type EnqueueEmailOptions = {
  recipientUserId?: string | null;
  scenarioKey?: string;
  notificationType?: NotificationType;
  payloadJson?: Record<string, unknown> | null;
  priority?: EmailPriority;
  idempotencyKey?: string;
  dispatchImmediately?: boolean;
};

export type EmailDispatchStatus =
  | 'QUEUED'
  | 'SENT'
  | 'FAILED'
  | 'SUPPRESSED'
  | 'SKIPPED';

export type EnqueueEmailResult = {
  outboxId: string | null;
  dispatchStatus: EmailDispatchStatus;
  providerMessageId: string | null;
  errorMessage: string | null;
};

type SendNowOptions = {
  idempotencyKey?: string | null;
};

type SendNowResult = {
  providerMessageId: string | null;
  emailMode: EmailMode;
  transportRecipient: string | null;
  intendedRecipientLabel: string | null;
};

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly emailConfig: ResolvedEmailConfig;
  private readonly appName: string;
  private resendClient: Resend | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.emailConfig = resolveEmailConfig(config);
    this.appName = this.emailConfig.appName;

    this.emailConfig.warnings.forEach((warning) => this.logger.warn(warning));

    if (this.emailConfig.mode === 'log_only') {
      this.logger.warn(
        'Email transport is running in log_only mode; Resend will not be called and no real emails will be sent.',
      );
      return;
    }

    this.logger.log(
      `Email transport configured: provider=${this.emailConfig.deliveryProviderName} mode=${this.emailConfig.mode} endpoint=${this.emailConfig.transportHost ?? 'n/a'} from=${this.emailConfig.fromAddress ? maskEmailForLog(this.emailConfig.fromAddress) : 'not_configured'}`,
    );
  }

  async send(
    to: string,
    subject: string,
    html: string,
    text?: string,
    options?: EnqueueEmailOptions,
  ): Promise<EnqueueEmailResult> {
    let outboxRowId: string | null = null;
    const shouldStoreBody = this.emailConfig.mode !== 'log_only';
    const storedHtml = shouldStoreBody
      ? html
      : '<p>Email body omitted in log_only mode.</p>';
    const storedText = shouldStoreBody
      ? (text ?? null)
      : 'Email body omitted in log_only mode.';

    try {
      const outboxRow = await this.prisma.emailOutbox.create({
        data: {
          recipientUserId: options?.recipientUserId ?? null,
          recipientEmailSnapshot: to,
          scenarioKey: options?.scenarioKey ?? 'legacy.direct',
          notificationType: options?.notificationType,
          subject,
          html: storedHtml,
          text: storedText,
          payloadJson: (options?.payloadJson ?? null) as Prisma.InputJsonValue,
          priority: options?.priority ?? EmailPriority.P2_OPERATIONAL,
          idempotencyKey: options?.idempotencyKey,
        },
        select: { id: true },
      });
      outboxRowId = outboxRow.id;

      this.logger.debug(
        `Email enqueued to outboxId=${outboxRowId} scenario=${options?.scenarioKey ?? 'legacy.direct'} immediate=${options?.dispatchImmediately ? 'true' : 'false'} to=${maskEmailForLog(to)}`,
      );
    } catch (error: any) {
      if (error?.code === 'P2002' && options?.idempotencyKey) {
        this.logger.debug(
          `Skipped duplicate outbox enqueue for idempotencyKey=${options.idempotencyKey}`,
        );
        return {
          outboxId: null,
          dispatchStatus: 'SKIPPED',
          providerMessageId: null,
          errorMessage: null,
        };
      }

      const message = this.formatSafeEmailError(error);
      this.logger.error(
        `Failed to enqueue email for ${maskEmailForLog(to)}: ${message}`,
      );
      return {
        outboxId: null,
        dispatchStatus: 'FAILED',
        providerMessageId: null,
        errorMessage: message,
      };
    }

    if (options?.dispatchImmediately && outboxRowId) {
      return this.dispatchOutboxRowNow(
        outboxRowId,
        to,
        subject,
        storedHtml,
        storedText ?? undefined,
        options.idempotencyKey,
      );
    }

    return {
      outboxId: outboxRowId,
      dispatchStatus: 'QUEUED',
      providerMessageId: null,
      errorMessage: null,
    };
  }

  async sendNow(
    to: string,
    subject: string,
    html: string,
    text?: string,
    options?: SendNowOptions,
  ): Promise<SendNowResult> {
    const normalizedEmail = to.trim().toLowerCase();

    if (this.emailConfig.mode === 'log_only') {
      this.logger.log(
        `[EMAIL-LOG-ONLY] to=${maskEmailForLog(normalizedEmail)} subject="${this.truncateForLog(subject)}"`,
      );
      this.logger.debug('[EMAIL-LOG-ONLY] Body omitted from logs');
      return {
        providerMessageId: 'log-only',
        emailMode: this.emailConfig.mode,
        transportRecipient: null,
        intendedRecipientLabel: maskEmailForLog(normalizedEmail),
      };
    }

    this.assertResendTransportConfig();
    await this.assertDailyLimitAvailable();

    const outbound = this.resolveOutboundRecipient(normalizedEmail);
    const resend = this.getResendClient();

    try {
      const response = await resend.emails.send(
        {
          from: this.emailConfig.from as string,
          to: outbound.transportRecipient,
          subject,
          html,
          text: text || undefined,
          replyTo: this.emailConfig.replyTo ?? undefined,
        },
        {
          idempotencyKey:
            options?.idempotencyKey ??
            this.buildSendIdempotencyKey(subject, to),
        },
      );

      if (response.error) {
        throw response.error;
      }

      const providerMessageId = response.data?.id ?? null;
      this.logger.log(
        `Email sent via Resend mode=${this.emailConfig.mode} to=${maskEmailForLog(outbound.transportRecipient)} intended=${outbound.intendedRecipientLabel ?? 'n/a'} providerMessageId=${providerMessageId ?? 'n/a'}`,
      );

      return {
        providerMessageId,
        emailMode: this.emailConfig.mode,
        transportRecipient: maskEmailForLog(outbound.transportRecipient),
        intendedRecipientLabel: outbound.intendedRecipientLabel,
      };
    } catch (error) {
      const message = this.formatSafeEmailError(error);
      this.logger.error(
        `Failed to send email via Resend mode=${this.emailConfig.mode} to=${maskEmailForLog(outbound.transportRecipient)} intended=${outbound.intendedRecipientLabel ?? 'n/a'} error=${message}`,
      );
      throw new Error(message);
    }
  }

  getAppName(): string {
    return this.appName;
  }

  getDeliveryAttemptProvider(): string {
    return this.emailConfig.deliveryProviderName;
  }

  getTransportHost(): string | null {
    return this.emailConfig.transportHost;
  }

  private getResendClient(): Resend {
    if (!this.emailConfig.resendApiKey) {
      throw new Error('RESEND_CONFIG_MISSING: RESEND_API_KEY');
    }

    if (!this.resendClient) {
      this.resendClient = new Resend(this.emailConfig.resendApiKey);
    }

    return this.resendClient;
  }

  private assertResendTransportConfig(): void {
    const missing: string[] = [];
    if (!this.emailConfig.resendApiKey) {
      missing.push('RESEND_API_KEY');
    }
    if (!this.emailConfig.from) {
      missing.push('RESEND_FROM');
    }
    if (!this.emailConfig.fromAddress) {
      missing.push('RESEND_FROM_VALID_ADDRESS');
    }
    if (this.emailConfig.mode === 'redirect' && !this.emailConfig.redirectTo) {
      missing.push('SIT_EMAIL_REDIRECT_TO');
    }

    if (missing.length > 0) {
      throw new Error(`RESEND_CONFIG_MISSING: ${missing.join(',')}`);
    }
  }

  private async assertDailyLimitAvailable(): Promise<void> {
    const limit = this.emailConfig.dailyLimit;
    if (!limit || this.emailConfig.mode === 'log_only') {
      return;
    }

    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const sentToday = await this.prisma.emailDeliveryAttempt.count({
      where: {
        provider: 'RESEND',
        result: 'SENT',
        createdAt: { gte: startOfDay },
      },
    });

    if (sentToday >= limit) {
      throw new Error(
        `EMAIL_DAILY_LIMIT_REACHED: limit=${limit} sentToday=${sentToday}`,
      );
    }
  }

  private resolveOutboundRecipient(intendedRecipient: string): {
    transportRecipient: string;
    intendedRecipientLabel: string | null;
  } {
    if (this.emailConfig.mode !== 'redirect') {
      return {
        transportRecipient: intendedRecipient,
        intendedRecipientLabel: null,
      };
    }

    const intendedRecipientLabel = this.emailConfig.logIntendedRecipient
      ? intendedRecipient
      : maskEmailForLog(intendedRecipient);

    return {
      transportRecipient: this.emailConfig.redirectTo as string,
      intendedRecipientLabel,
    };
  }

  private buildSendIdempotencyKey(subject: string, to: string): string {
    const fingerprint = createHash('sha256')
      .update(`${to.trim().toLowerCase()}:${subject}`)
      .digest('hex')
      .slice(0, 32);
    return `email:${fingerprint}`;
  }

  private async dispatchOutboxRowNow(
    outboxRowId: string,
    to: string,
    subject: string,
    html: string,
    text?: string,
    idempotencyKey?: string | null,
  ): Promise<EnqueueEmailResult> {
    const now = new Date();
    const claim = await this.prisma.emailOutbox.updateMany({
      where: {
        id: outboxRowId,
        status: EmailOutboxStatus.PENDING,
      },
      data: {
        status: EmailOutboxStatus.PROCESSING,
        attempts: { increment: 1 },
        lockedAt: now,
        lockOwner: `inline-${process.pid}`,
        lockExpiresAt: new Date(now.getTime() + 60_000),
        lastError: null,
      },
    });

    if (claim.count === 0) {
      return {
        outboxId: outboxRowId,
        dispatchStatus: 'SKIPPED',
        providerMessageId: null,
        errorMessage: null,
      };
    }

    const normalizedEmail = to.trim().toLowerCase();
    const emailHash = createHash('sha256')
      .update(normalizedEmail)
      .digest('hex');
    const suppression = await this.prisma.emailSuppression.findFirst({
      where: {
        recipientEmailHash: emailHash,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true, reason: true },
    });

    if (suppression) {
      await this.prisma.$transaction([
        this.prisma.emailDeliveryAttempt.create({
          data: {
            emailOutboxId: outboxRowId,
            attemptNo: 1,
            provider: 'SUPPRESSION',
            result: 'SUPPRESSED',
            errorCode: String(suppression.reason),
            errorMessage: 'Suppressed by deliverability policy',
          },
        }),
        this.prisma.emailOutbox.update({
          where: { id: outboxRowId },
          data: {
            status: EmailOutboxStatus.COMPLETED,
            sentAt: new Date(),
            lastError: 'SUPPRESSED',
            lockExpiresAt: null,
          },
        }),
      ]);
      this.logger.warn(
        `Email suppressed by policy outboxId=${outboxRowId} reason=${suppression.reason} to=${maskEmailForLog(normalizedEmail)}`,
      );
      return {
        outboxId: outboxRowId,
        dispatchStatus: 'SUPPRESSED',
        providerMessageId: null,
        errorMessage: `SUPPRESSED:${suppression.reason}`,
      };
    }

    try {
      const providerResult = await this.sendNow(
        normalizedEmail,
        subject,
        html,
        text,
        {
          idempotencyKey: idempotencyKey ?? `outbox:${outboxRowId}`,
        },
      );

      await this.prisma.$transaction([
        this.prisma.emailDeliveryAttempt.create({
          data: {
            emailOutboxId: outboxRowId,
            attemptNo: 1,
            provider: this.getDeliveryAttemptProvider(),
            transportHost: this.getTransportHost(),
            result: 'SENT',
            providerResponseJson: {
              providerMessageId: providerResult.providerMessageId,
              emailMode: providerResult.emailMode,
              transportRecipient: providerResult.transportRecipient,
              intendedRecipient: providerResult.intendedRecipientLabel,
            } as Prisma.InputJsonValue,
          },
        }),
        this.prisma.emailOutbox.update({
          where: { id: outboxRowId },
          data: {
            status: EmailOutboxStatus.COMPLETED,
            providerMessageId: providerResult.providerMessageId,
            sentAt: new Date(),
            lockExpiresAt: null,
          },
        }),
      ]);
      this.logger.log(
        `Email dispatched in real time outboxId=${outboxRowId} to=${maskEmailForLog(normalizedEmail)} providerMessageId=${providerResult.providerMessageId ?? 'n/a'}`,
      );
      return {
        outboxId: outboxRowId,
        dispatchStatus: 'SENT',
        providerMessageId: providerResult.providerMessageId,
        errorMessage: null,
      };
    } catch (error) {
      const message = this.formatSafeEmailError(error);
      await this.prisma.$transaction([
        this.prisma.emailDeliveryAttempt.create({
          data: {
            emailOutboxId: outboxRowId,
            attemptNo: 1,
            provider: this.getDeliveryAttemptProvider(),
            transportHost: this.getTransportHost(),
            result: 'FAILED',
            errorMessage: message,
          },
        }),
        this.prisma.emailOutbox.update({
          where: { id: outboxRowId },
          data: {
            status: EmailOutboxStatus.FAILED,
            lastError: message,
            availableAt: new Date(Date.now() + 30_000),
            lockExpiresAt: null,
          },
        }),
      ]);
      this.logger.error(
        `Real-time email dispatch failed outboxId=${outboxRowId} to=${maskEmailForLog(normalizedEmail)} error=${message}`,
      );
      return {
        outboxId: outboxRowId,
        dispatchStatus: 'FAILED',
        providerMessageId: null,
        errorMessage: message,
      };
    }
  }

  private formatSafeEmailError(error: unknown): string {
    const errorLike = error as {
      name?: unknown;
      message?: unknown;
      statusCode?: unknown;
      status?: unknown;
      code?: unknown;
    };
    const parts = [
      typeof errorLike?.name === 'string' ? errorLike.name : null,
      typeof errorLike?.code === 'string' ? errorLike.code : null,
      typeof errorLike?.statusCode === 'number'
        ? `status=${errorLike.statusCode}`
        : typeof errorLike?.status === 'number'
          ? `status=${errorLike.status}`
          : null,
      typeof errorLike?.message === 'string'
        ? errorLike.message
        : error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : null,
    ].filter(Boolean);

    const raw = parts.length > 0 ? parts.join(': ') : 'Unknown email error';
    return this.truncateForLog(this.redactSensitiveText(raw), 240);
  }

  private redactSensitiveText(value: string): string {
    return value
      .replace(/https?:\/\/\S+/gi, '[url-redacted]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email-redacted]')
      .replace(
        /\b(api[_-]?key|secret|token|otp|code|password)=?[^\s&]*/gi,
        '$1=[redacted]',
      )
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token-redacted]');
  }

  private truncateForLog(value: string, maxLength = 160): string {
    const trimmed = value.trim();
    if (trimmed.length <= maxLength) {
      return trimmed;
    }

    return `${trimmed.slice(0, maxLength - 3)}...`;
  }
}
