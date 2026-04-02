import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EmailOutboxStatus, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { EmailService } from 'src/email/email.service';

const EMAIL_OUTBOX_MAX_ATTEMPTS = 8;
const EMAIL_OUTBOX_CONCURRENCY = 10;
const EMAIL_OUTBOX_COMPLETED_RETENTION_DAYS = 30;
const EMAIL_OUTBOX_EXHAUSTED_RETENTION_DAYS = 90;
const EMAIL_OUTBOX_DISPATCH_CRON = '*/10 * * * * *';

@Injectable()
export class EmailOutboxDispatcherService {
  private readonly logger = new Logger(EmailOutboxDispatcherService.name);
  private readonly lockOwner = `api-${process.pid}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  @Cron(EMAIL_OUTBOX_DISPATCH_CRON)
  async dispatchPendingEmails(batchSize = 150): Promise<void> {
    const rows = await this.prisma.emailOutbox.findMany({
      where: {
        status: { in: [EmailOutboxStatus.PENDING, EmailOutboxStatus.FAILED] },
        availableAt: { lte: new Date() },
        attempts: { lt: EMAIL_OUTBOX_MAX_ATTEMPTS },
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      take: batchSize,
    });

    if (rows.length === 0) {
      return;
    }

    this.logger.log(
      `Email outbox sweep picked ${rows.length} row(s) for dispatch`,
    );

    let sent = 0;
    let failed = 0;
    let suppressed = 0;

    for (let i = 0; i < rows.length; i += EMAIL_OUTBOX_CONCURRENCY) {
      const chunk = rows.slice(i, i + EMAIL_OUTBOX_CONCURRENCY);
      const results = await Promise.all(chunk.map((row) => this.dispatchRow(row)));
      results.forEach((result) => {
        if (result === 'SENT') {
          sent += 1;
          return;
        }

        if (result === 'FAILED') {
          failed += 1;
          return;
        }

        if (result === 'SUPPRESSED') {
          suppressed += 1;
        }
      });
    }

    this.logger.log(
      `Email outbox sweep completed sent=${sent} failed=${failed} suppressed=${suppressed} total=${rows.length}`,
    );
  }

  private async dispatchRow(row: {
    id: string;
    status: EmailOutboxStatus;
    attempts: number;
    recipientEmailSnapshot: string;
    subject: string;
    html: string;
    text: string | null;
  }): Promise<'SENT' | 'FAILED' | 'SUPPRESSED' | 'SKIPPED'> {
    const claim = await this.prisma.emailOutbox.updateMany({
      where: { id: row.id, status: row.status },
      data: {
        status: EmailOutboxStatus.PROCESSING,
        attempts: { increment: 1 },
        lockedAt: new Date(),
        lockOwner: this.lockOwner,
        lockExpiresAt: new Date(Date.now() + 60_000),
        lastError: null,
      },
    });
    if (claim.count === 0) {
      return 'SKIPPED';
    }

    const attemptNo = row.attempts + 1;
    const normalizedEmail = row.recipientEmailSnapshot.trim().toLowerCase();
    const emailHash = createHash('sha256').update(normalizedEmail).digest('hex');

    try {
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
              emailOutboxId: row.id,
              attemptNo,
              provider: 'SUPPRESSION',
              result: 'SUPPRESSED',
              errorCode: String(suppression.reason),
              errorMessage: 'Suppressed by deliverability policy',
            },
          }),
          this.prisma.emailOutbox.update({
            where: { id: row.id },
            data: {
              status: EmailOutboxStatus.COMPLETED,
              sentAt: new Date(),
              lastError: 'SUPPRESSED',
              lockExpiresAt: null,
            },
          }),
        ]);
        this.logger.warn(
          `Outbox row suppressed outboxId=${row.id} reason=${suppression.reason}`,
        );
        return 'SUPPRESSED';
      }

      const providerResult = await this.emailService.sendNow(
        normalizedEmail,
        row.subject,
        row.html,
        row.text ?? undefined,
      );

      await this.prisma.$transaction([
        this.prisma.emailDeliveryAttempt.create({
          data: {
            emailOutboxId: row.id,
            attemptNo,
            provider: this.emailService.getDeliveryAttemptProvider(),
            smtpHost: this.emailService.getTransportHost(),
            result: 'SENT',
            providerResponseJson: {
              providerMessageId: providerResult.providerMessageId,
            } as Prisma.InputJsonValue,
          },
        }),
        this.prisma.emailOutbox.update({
          where: { id: row.id },
          data: {
            status: EmailOutboxStatus.COMPLETED,
            providerMessageId: providerResult.providerMessageId,
            sentAt: new Date(),
            lockExpiresAt: null,
          },
        }),
      ]);

      return 'SENT';
    } catch (error) {
      const message = this.formatError(error);
      const exhausted = attemptNo >= EMAIL_OUTBOX_MAX_ATTEMPTS;
      const backoffSeconds = Math.min(3600, Math.pow(2, attemptNo) * 15);

      await this.prisma.$transaction([
        this.prisma.emailDeliveryAttempt.create({
          data: {
            emailOutboxId: row.id,
            attemptNo,
            provider: this.emailService.getDeliveryAttemptProvider(),
            smtpHost: this.emailService.getTransportHost(),
            result: 'FAILED',
            errorMessage: message,
          },
        }),
        this.prisma.emailOutbox.update({
          where: { id: row.id },
          data: {
            status: EmailOutboxStatus.FAILED,
            lastError: exhausted ? `DLQ_EXHAUSTED:${message}` : message,
            availableAt: exhausted
              ? new Date(Date.now() + 24 * 60 * 60 * 1000)
              : new Date(Date.now() + backoffSeconds * 1000),
            lockExpiresAt: null,
          },
        }),
      ]);

      if (exhausted) {
        this.logger.error(`Email outbox exhausted retries outboxId=${row.id}`);
      } else {
        this.logger.warn(
          `Email outbox dispatch failed outboxId=${row.id} attempt=${attemptNo} error=${message}`,
        );
      }

      return 'FAILED';
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async cleanupEmailOutboxRows(): Promise<void> {
    const now = Date.now();
    const completedBefore = new Date(
      now - EMAIL_OUTBOX_COMPLETED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const exhaustedBefore = new Date(
      now - EMAIL_OUTBOX_EXHAUSTED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.prisma.emailOutbox.deleteMany({
      where: {
        status: EmailOutboxStatus.COMPLETED,
        sentAt: { lt: completedBefore },
      },
    });

    await this.prisma.emailOutbox.deleteMany({
      where: {
        status: EmailOutboxStatus.FAILED,
        lastError: { startsWith: 'DLQ_EXHAUSTED:' },
        updatedAt: { lt: exhaustedBefore },
      },
    });
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
