import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import { EmailService } from 'src/email/email.service';

const NOTIFICATION_TEMPLATES: Record<
  string,
  { subject: string; body: string }
> = {
  'account.suspended': {
    subject: 'Your account has been suspended',
    body: 'Your WEAZ account has been suspended by an administrator. If you believe this was in error, please contact support.',
  },
  'account.reactivated': {
    subject: 'Your account has been reactivated',
    body: 'Your WEAZ account has been reactivated. You can now log in and use all features.',
  },
  'brand.verified': {
    subject: 'Your brand has been verified',
    body: 'Congratulations! Your brand on WEAZ has been verified by our team.',
  },
  'brand.suspended': {
    subject: 'Your brand has been suspended',
    body: 'Your brand on WEAZ has been suspended. Products and store are temporarily hidden.',
  },
  'payout.processed': {
    subject: 'Your payout has been processed',
    body: 'Your payout on WEAZ has been processed and funds are on their way.',
  },
  'dispute.opened': {
    subject: 'A dispute has been opened',
    body: 'A dispute has been opened regarding your transaction on WEAZ.',
  },
  'dispute.resolved': {
    subject: 'Your dispute has been resolved',
    body: 'A dispute you were involved in has been resolved by our team.',
  },
  'password.reset.required': {
    subject: 'Password reset required',
    body: 'An administrator has required you to reset your password on your next login.',
  },
};

const escapeEmailHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r?\n/g, '<br />');

@Injectable()
export class AdminNotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  getTemplates() {
    return Object.entries(NOTIFICATION_TEMPLATES).map(([id, template]) => ({
      id,
      ...template,
    }));
  }

  async send(
    dto: {
      targetUserId: string;
      channel: string;
      relatedAuditLogId?: string;
      messageTemplate: string;
      customMessage?: string;
    },
    actorId: string,
    req: Request,
  ) {
    const template = NOTIFICATION_TEMPLATES[dto.messageTemplate];
    const subject = template?.subject ?? dto.messageTemplate;
    const body = dto.customMessage
      ? `${template?.body ?? ''}\n\nAdmin note: ${dto.customMessage}`
      : (template?.body ?? '');

    const notification = await this.prisma.$transaction(async (tx) => {
      const notif = await (tx as any).adminNotificationLog.create({
        data: {
          id: uuidv4(),
          adminUserId: actorId,
          targetType: 'User',
          targetId: dto.targetUserId,
          channel: dto.channel,
          templateKey: dto.messageTemplate,
          message: dto.customMessage ?? body ?? null,
        },
      });

      // Create in-app notification if channel includes in_app
      if (dto.channel === 'in_app' || dto.channel === 'both') {
        await tx.notification.create({
          data: {
            id: uuidv4(),
            recipientId: dto.targetUserId,
            actorId,
            type: 'ADMIN_ACTION',
            payload: { subject, body, template: dto.messageTemplate },
          },
        });
      }

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_NOTIFICATION_SEND,
          targetType: 'User',
          targetId: dto.targetUserId,
          newState: {
            channel: dto.channel,
            template: dto.messageTemplate,
            notificationLogId: notif.id,
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return notif;
    });

    // Send email if channel includes email
    if (dto.channel === 'email' || dto.channel === 'both') {
      const targetUser = await this.prisma.user.findUnique({
        where: { id: dto.targetUserId },
        select: { email: true },
      });
      if (targetUser?.email) {
        void this.emailService
          .send(
            targetUser.email,
            subject,
            `<p>${escapeEmailHtml(body)}</p>`,
            body,
          )
          .catch(() => undefined);
      }
    }

    return notification;
  }
}
