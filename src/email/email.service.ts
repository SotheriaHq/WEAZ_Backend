import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { EmailPriority, NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

export type EnqueueEmailOptions = {
  recipientUserId?: string | null;
  scenarioKey?: string;
  notificationType?: NotificationType;
  payloadJson?: Record<string, unknown> | null;
  priority?: EmailPriority;
  idempotencyKey?: string;
};

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;
  private readonly fromAddress: string;
  private readonly appName: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.fromAddress = config.get<string>('DEFAULT_MAILER', 'noreply@threadly.app');
    this.appName = config.get<string>('APP_NAME', 'Threadly');

    const host = config.get<string>('SMTP_HOST');
    const port = Number(config.get<string>('SMTP_PORT', '587'));
    const user = config.get<string>('SMTP_USER');
    const pass = config.get<string>('SMTP_PASS');

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      this.logger.log(`Email transport configured: ${host}:${port}`);
    } else {
      this.logger.warn(
        'SMTP credentials not configured — emails will be logged to console only',
      );
    }
  }

  async send(
    to: string,
    subject: string,
    html: string,
    text?: string,
    options?: EnqueueEmailOptions,
  ): Promise<void> {
    try {
      await this.prisma.emailOutbox.create({
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
      });

      this.logger.debug(`Email enqueued to outbox: to=${to} subject="${subject}"`);
    } catch (error: any) {
      if (error?.code === 'P2002' && options?.idempotencyKey) {
        this.logger.debug(
          `Skipped duplicate outbox enqueue for idempotencyKey=${options.idempotencyKey}`,
        );
        return;
      }

      this.logger.error(`Failed to enqueue email for ${to}: ${error.message}`);
    }
  }

  async sendNow(
    to: string,
    subject: string,
    html: string,
    text?: string,
  ): Promise<{ providerMessageId: string | null }> {
    if (!this.transporter) {
      this.logger.log(`[EMAIL-DEV] To: ${to} | Subject: ${subject}`);
      this.logger.debug(`[EMAIL-DEV] Body:\n${text || '(html only)'}`);
      return { providerMessageId: 'dev-local-transport' };
    }

    try {
      const info = await this.transporter.sendMail({
        from: `"${this.appName}" <${this.fromAddress}>`,
        to,
        subject,
        html,
        text: text || undefined,
      });

      this.logger.log(`Email sent to ${to}: "${subject}"`);
      return { providerMessageId: (info?.messageId as string | undefined) ?? null };
    } catch (error: any) {
      this.logger.error(`Failed to send email to ${to}: ${error.message}`);
      throw error;
    }
  }

  getAppName(): string {
    return this.appName;
  }
}
