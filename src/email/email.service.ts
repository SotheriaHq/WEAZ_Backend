import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import * as https from 'https';
import {
  EmailOutboxStatus,
  EmailPriority,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { resolveEmailConfig, type ResolvedEmailConfig } from './email.config';

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

const parseBooleanEnvFlag = (
  value: string | null | undefined,
  fallback: boolean,
): boolean => {
  if (value == null) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(normalized);
};

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;
  private readonly fromAddress: string;
  private readonly appName: string;
  private readonly fromName: string;
  private readonly replyTo: string | null;
  private readonly emailConfig: ResolvedEmailConfig;
  private readonly normalizedFromAddress: string;
  private readonly mailjetSenderValidationEnabled: boolean;
  private readonly mailjetEnforceActiveSender: boolean;
  private mailjetSenderValidationPromise: Promise<void> | null = null;
  private mailjetSenderState: 'unknown' | 'active' | 'inactive' | 'check_failed' =
    'unknown';
  private mailjetSenderStateDetail: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.emailConfig = resolveEmailConfig(config);
    this.fromAddress = this.emailConfig.fromAddress;
    this.appName = this.emailConfig.appName;
    this.fromName = this.emailConfig.fromName;
    this.replyTo = this.emailConfig.replyTo;
    this.normalizedFromAddress = this.fromAddress.trim().toLowerCase();
    this.mailjetSenderValidationEnabled = parseBooleanEnvFlag(
      this.config.get<string>('MAILJET_VALIDATE_SENDER_STATUS'),
      true,
    );
    this.mailjetEnforceActiveSender = parseBooleanEnvFlag(
      this.config.get<string>('MAILJET_ENFORCE_ACTIVE_SENDER'),
      true,
    );

    this.emailConfig.warnings.forEach((warning) => this.logger.warn(warning));

    if (
      this.emailConfig.transportEnabled &&
      this.emailConfig.smtpHost &&
      this.emailConfig.smtpPort &&
      this.emailConfig.smtpUser &&
      this.emailConfig.smtpPass
    ) {
      this.transporter = nodemailer.createTransport({
        host: this.emailConfig.smtpHost,
        port: this.emailConfig.smtpPort,
        secure: this.emailConfig.smtpPort === 465,
        auth: {
          user: this.emailConfig.smtpUser,
          pass: this.emailConfig.smtpPass,
        },
      });
      this.logger.log(
        `Email transport configured: provider=${this.emailConfig.deliveryProviderName} relay=${this.emailConfig.smtpHost}:${this.emailConfig.smtpPort} from=${this.fromAddress}`,
      );
      void this.verifyTransport(
        this.emailConfig.smtpHost,
        this.emailConfig.smtpPort,
      );

      if (
        this.emailConfig.provider === 'mailjet' &&
        this.mailjetSenderValidationEnabled
      ) {
        this.mailjetSenderValidationPromise = this.validateMailjetSenderStatus();
      }
    } else {
      this.logger.warn(
        `Email transport not configured for provider=${this.emailConfig.provider}; emails will be logged to console only`,
      );
    }
  }

  async send(
    to: string,
    subject: string,
    html: string,
    text?: string,
    options?: EnqueueEmailOptions,
  ): Promise<EnqueueEmailResult> {
    let outboxRowId: string | null = null;
    try {
      const outboxRow = await this.prisma.emailOutbox.create({
        data: {
          recipientUserId: options?.recipientUserId ?? null,
          recipientEmailSnapshot: to,
          scenarioKey: options?.scenarioKey ?? 'legacy.direct',
          notificationType: options?.notificationType,
          subject,
          html,
          text: text ?? null,
          payloadJson: (options?.payloadJson ?? null) as Prisma.InputJsonValue,
          priority: options?.priority ?? EmailPriority.P2_OPERATIONAL,
          idempotencyKey: options?.idempotencyKey,
        },
        select: { id: true },
      });
      outboxRowId = outboxRow.id;

      this.logger.debug(
        `Email enqueued to outboxId=${outboxRowId} scenario=${options?.scenarioKey ?? 'legacy.direct'} immediate=${options?.dispatchImmediately ? 'true' : 'false'} to=${to}`,
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

      this.logger.error(`Failed to enqueue email for ${to}: ${error.message}`);
      return {
        outboxId: null,
        dispatchStatus: 'FAILED',
        providerMessageId: null,
        errorMessage: error?.message ?? String(error),
      };
    }

    if (options?.dispatchImmediately && outboxRowId) {
      return this.dispatchOutboxRowNow(outboxRowId, to, subject, html, text);
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
  ): Promise<{ providerMessageId: string | null }> {
    await this.ensureMailjetSenderIsReady(to, subject);

    if (!this.transporter) {
      this.logger.log(`[EMAIL-DEV] To: ${to} | Subject: ${subject}`);
      this.logger.debug(`[EMAIL-DEV] Body:\n${text || '(html only)'}`);
      return { providerMessageId: 'dev-local-transport' };
    }

    try {
      const info = await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromAddress}>`,
        to,
        subject,
        html,
        text: text || undefined,
        replyTo: this.replyTo ?? undefined,
      });

      const providerMessageId = (info?.messageId as string | undefined) ?? null;
      this.logger.log(
        `Email sent to ${to}: "${subject}" providerMessageId=${providerMessageId ?? 'n/a'}`,
      );
      return { providerMessageId };
    } catch (error: any) {
      this.logger.error(`Failed to send email to ${to}: ${error.message}`);
      throw error;
    }
  }

  getAppName(): string {
    return this.appName;
  }

  getDeliveryAttemptProvider(): string {
    return this.transporter ? this.emailConfig.deliveryProviderName : 'CONSOLE';
  }

  getTransportHost(): string | null {
    return this.transporter ? this.emailConfig.smtpHost : null;
  }

  private async verifyTransport(host: string, port: number): Promise<void> {
    if (!this.transporter) {
      return;
    }

    try {
      await this.transporter.verify();
      this.logger.log(`Email transport verified: ${host}:${port}`);
    } catch (error: any) {
      this.logger.error(
        `Email transport verification failed for ${host}:${port}: ${error.message}`,
      );
    }
  }

  private async dispatchOutboxRowNow(
    outboxRowId: string,
    to: string,
    subject: string,
    html: string,
    text?: string,
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
    const emailHash = createHash('sha256').update(normalizedEmail).digest('hex');
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
        `Email suppressed by policy outboxId=${outboxRowId} reason=${suppression.reason} to=${normalizedEmail}`,
      );
      return {
        outboxId: outboxRowId,
        dispatchStatus: 'SUPPRESSED',
        providerMessageId: null,
        errorMessage: `SUPPRESSED:${suppression.reason}`,
      };
    }

    try {
      const providerResult = await this.sendNow(normalizedEmail, subject, html, text);

      await this.prisma.$transaction([
        this.prisma.emailDeliveryAttempt.create({
          data: {
            emailOutboxId: outboxRowId,
            attemptNo: 1,
            provider: this.getDeliveryAttemptProvider(),
            smtpHost: this.getTransportHost(),
            result: 'SENT',
            providerResponseJson: {
              providerMessageId: providerResult.providerMessageId,
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
        `Email dispatched in real time outboxId=${outboxRowId} to=${normalizedEmail} providerMessageId=${providerResult.providerMessageId ?? 'n/a'}`,
      );
      return {
        outboxId: outboxRowId,
        dispatchStatus: 'SENT',
        providerMessageId: providerResult.providerMessageId,
        errorMessage: null,
      };
    } catch (error: any) {
      const message = error?.message ?? String(error);
      await this.prisma.$transaction([
        this.prisma.emailDeliveryAttempt.create({
          data: {
            emailOutboxId: outboxRowId,
            attemptNo: 1,
            provider: this.getDeliveryAttemptProvider(),
            smtpHost: this.getTransportHost(),
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
        `Real-time email dispatch failed outboxId=${outboxRowId} to=${normalizedEmail} error=${message}`,
      );
      return {
        outboxId: outboxRowId,
        dispatchStatus: 'FAILED',
        providerMessageId: null,
        errorMessage: message,
      };
    }
  }

  private async ensureMailjetSenderIsReady(
    to: string,
    subject: string,
  ): Promise<void> {
    if (
      this.emailConfig.provider !== 'mailjet' ||
      !this.mailjetSenderValidationEnabled
    ) {
      return;
    }

    if (!this.mailjetSenderValidationPromise) {
      this.mailjetSenderValidationPromise = this.validateMailjetSenderStatus();
    }

    await this.mailjetSenderValidationPromise;

    if (this.mailjetSenderState === 'check_failed') {
      this.logger.warn(
        `Retrying Mailjet sender validation before send for ${this.fromAddress}`,
      );
      this.mailjetSenderValidationPromise = this.validateMailjetSenderStatus();
      await this.mailjetSenderValidationPromise;
    }

    if (this.mailjetSenderState === 'inactive') {
      const detail = this.mailjetSenderStateDetail ?? 'unknown sender status';
      const message = `Mailjet sender ${this.fromAddress} is not active (${detail})`;

      if (this.mailjetEnforceActiveSender) {
        this.logger.error(
          `Blocking email send to ${to} subject="${subject}" because ${message}`,
        );
        throw new Error(`MAILJET_SENDER_INACTIVE: ${message}`);
      }

      this.logger.warn(
        `Continuing email send because MAILJET_ENFORCE_ACTIVE_SENDER=false even though ${message}`,
      );
    }

    if (this.mailjetSenderState === 'check_failed') {
      this.logger.warn(
        `Mailjet sender validation could not be confirmed for ${this.fromAddress}; continuing send to avoid hard outage. detail=${this.mailjetSenderStateDetail ?? 'n/a'}`,
      );
    }
  }

  private async validateMailjetSenderStatus(): Promise<void> {
    if (this.emailConfig.provider !== 'mailjet') {
      return;
    }

    try {
      const sender = await this.fetchMailjetSender(this.normalizedFromAddress);

      if (!sender) {
        this.mailjetSenderState = 'inactive';
        this.mailjetSenderStateDetail = 'sender identity not found in Mailjet';
        this.logger.error(
          `Mailjet sender validation failed for ${this.fromAddress}: ${this.mailjetSenderStateDetail}`,
        );
        return;
      }

      const normalizedStatus = sender.status.trim().toLowerCase();
      if (normalizedStatus === 'active') {
        this.mailjetSenderState = 'active';
        this.mailjetSenderStateDetail = `senderId=${sender.id ?? 'n/a'} status=${sender.status}`;
        this.logger.log(
          `Mailjet sender validation passed for ${this.fromAddress}: ${this.mailjetSenderStateDetail}`,
        );
        return;
      }

      this.mailjetSenderState = 'inactive';
      this.mailjetSenderStateDetail = `senderId=${sender.id ?? 'n/a'} status=${sender.status || 'unknown'}`;
      this.logger.error(
        `Mailjet sender validation failed for ${this.fromAddress}: ${this.mailjetSenderStateDetail}`,
      );
    } catch (error: any) {
      this.mailjetSenderState = 'check_failed';
      this.mailjetSenderStateDetail = error?.message ?? String(error);
      this.logger.warn(
        `Mailjet sender validation check failed for ${this.fromAddress}: ${this.mailjetSenderStateDetail}`,
      );
    }
  }

  private async fetchMailjetSender(
    emailAddress: string,
  ): Promise<{ status: string; id: string | number | null } | null> {
    const response = await this.requestMailjetSender(emailAddress);
    if (response.statusCode !== 200) {
      throw new Error(
        `Mailjet sender lookup returned HTTP ${response.statusCode}`,
      );
    }

    let parsedBody: any = null;
    try {
      parsedBody = JSON.parse(response.body || '{}');
    } catch {
      throw new Error('Mailjet sender lookup returned invalid JSON');
    }

    const data = Array.isArray(parsedBody?.Data) ? parsedBody.Data : [];
    const senderRow =
      data.find(
        (row: any) =>
          typeof row?.Email === 'string' &&
          row.Email.trim().toLowerCase() === emailAddress,
      ) ?? null;

    if (!senderRow) {
      return null;
    }

    return {
      status: String(senderRow.Status ?? ''),
      id:
        typeof senderRow.ID === 'number' || typeof senderRow.ID === 'string'
          ? senderRow.ID
          : null,
    };
  }

  private async requestMailjetSender(
    emailAddress: string,
  ): Promise<{ statusCode: number; body: string }> {
    const apiKey = this.emailConfig.smtpUser;
    const secretKey = this.emailConfig.smtpPass;
    if (!apiKey || !secretKey) {
      throw new Error('Mailjet sender validation requires API key and secret');
    }

    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          hostname: 'api.mailjet.com',
          port: 443,
          method: 'GET',
          path: `/v3/REST/sender?Email=${encodeURIComponent(emailAddress)}`,
          headers: {
            Authorization: `Basic ${Buffer.from(`${apiKey}:${secretKey}`).toString('base64')}`,
          },
          timeout: 15000,
        },
        (response) => {
          let body = '';
          response.on('data', (chunk) => {
            body += chunk.toString();
          });
          response.on('end', () => {
            resolve({
              statusCode: response.statusCode ?? 0,
              body,
            });
          });
        },
      );

      request.on('timeout', () => {
        request.destroy(new Error('Mailjet sender lookup timed out'));
      });
      request.on('error', reject);
      request.end();
    });
  }
}
