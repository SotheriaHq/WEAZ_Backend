import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { EmailService } from 'src/email/email.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { EmailPriority, NotificationType } from '@prisma/client';
import { createHash, randomInt } from 'crypto';
import * as argon2 from 'argon2';
import * as emailTemplates from 'src/email/email.templates';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AdminEmailChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private hashOtp(otp: string): string {
    return createHash('sha256').update(otp).digest('hex');
  }

  private generateOtp(): string {
    return String(randomInt(100000, 999999));
  }

  async requestEmailChange(
    adminId: string,
    newEmail: string,
    currentPassword: string,
  ) {
    const normalized = newEmail.trim().toLowerCase();
    if (!normalized) throw new BadRequestException('New email is required');

    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { id: true, email: true, password: true, role: true },
    });
    if (!admin) throw new UnauthorizedException('User not found');
    if (admin.role !== 'Admin' && admin.role !== 'SuperAdmin') {
      throw new ForbiddenException('Only admin accounts use this workflow');
    }
    if (admin.email === normalized) {
      throw new BadRequestException(
        'New email must differ from your current email',
      );
    }
    if (!admin.password) {
      throw new BadRequestException(
        'Set a password before changing your email address',
      );
    }

    const passwordValid = await argon2.verify(admin.password, currentPassword);
    if (!passwordValid) throw new UnauthorizedException('Incorrect password');

    const taken = await (this.prisma as any).user.findFirst({
      where: {
        OR: [{ email: normalized }, { pendingEmail: normalized }],
        id: { not: adminId },
      },
      select: { id: true },
    });
    if (taken)
      throw new BadRequestException('That email address is already in use');

    // Cancel any prior pending request for this admin
    await (this.prisma as any).adminEmailChangeRequest.updateMany({
      where: {
        adminId,
        status: { in: ['PENDING_VERIFICATION', 'PENDING_APPROVAL'] },
      },
      data: { status: 'CANCELLED' },
    });

    const otp = this.generateOtp();
    const otpHash = this.hashOtp(otp);
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await (this.prisma as any).adminEmailChangeRequest.create({
      data: {
        id: uuidv4(),
        adminId,
        currentEmail: admin.email,
        newEmail: normalized,
        otpHash,
        otpExpiresAt,
        status: 'PENDING_VERIFICATION',
      },
    });

    const emailContent = emailTemplates.adminEmailChangeOtpEmail(
      otp,
      normalized,
      this.emailService.getAppName(),
    );
    await this.emailService.send(
      normalized,
      emailContent.subject,
      emailContent.html,
      emailContent.text,
      {
        recipientUserId: adminId,
        scenarioKey: 'admin.email_change.otp',
        priority: EmailPriority.P0_SECURITY,
        idempotencyKey: `admin:email-change:otp:${adminId}:${otpHash}`,
      },
    );

    return {
      message: `A 6-digit verification code has been sent to ${normalized}. It expires in 10 minutes.`,
      newEmail: normalized,
    };
  }

  async verifyOtp(adminId: string, otp: string) {
    const otpHash = this.hashOtp(otp.trim());

    const request = await (
      this.prisma as any
    ).adminEmailChangeRequest.findFirst({
      where: {
        adminId,
        otpHash,
        status: 'PENDING_VERIFICATION',
        otpExpiresAt: { gt: new Date() },
      },
    });

    if (!request)
      throw new BadRequestException('Invalid or expired verification code');

    await (this.prisma as any).adminEmailChangeRequest.update({
      where: { id: request.id },
      data: {
        status: 'PENDING_APPROVAL',
        otpVerifiedAt: new Date(),
        otpHash: null,
        otpExpiresAt: null,
      },
    });

    // Notify all SuperAdmins about the pending request
    const superAdmins = await this.prisma.user.findMany({
      where: { role: 'SuperAdmin' },
      select: { id: true },
    });

    const NT_ADMIN_EMAIL_CHANGE_REQUESTED =
      'ADMIN_EMAIL_CHANGE_REQUESTED' as NotificationType;
    for (const sa of superAdmins) {
      await this.notificationsService.create(
        sa.id,
        NT_ADMIN_EMAIL_CHANGE_REQUESTED,
        {
          actorId: adminId,
          payload: { requestId: request.id, newEmail: request.newEmail },
        },
      );
    }

    return {
      message:
        'Email verified. Your request is now pending Super Admin approval.',
      status: 'PENDING_APPROVAL',
    };
  }

  async getMyRequest(adminId: string) {
    const request = await (
      this.prisma as any
    ).adminEmailChangeRequest.findFirst({
      where: {
        adminId,
        status: { in: ['PENDING_VERIFICATION', 'PENDING_APPROVAL'] },
      },
      select: {
        id: true,
        newEmail: true,
        status: true,
        otpExpiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return request ?? null;
  }

  async cancelMyRequest(adminId: string) {
    const request = await (
      this.prisma as any
    ).adminEmailChangeRequest.findFirst({
      where: {
        adminId,
        status: { in: ['PENDING_VERIFICATION', 'PENDING_APPROVAL'] },
      },
    });

    if (!request) throw new NotFoundException('No active email change request');

    await (this.prisma as any).adminEmailChangeRequest.update({
      where: { id: request.id },
      data: { status: 'CANCELLED' },
    });

    return { message: 'Email change request cancelled' };
  }

  async listPendingRequests(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      (this.prisma as any).adminEmailChangeRequest.findMany({
        where: { status: 'PENDING_APPROVAL' },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: {
          admin: {
            select: {
              id: true,
              email: true,
              role: true,
              userProfile: { select: { displayName: true, avatarUrl: true } },
            },
          },
        },
      }),
      (this.prisma as any).adminEmailChangeRequest.count({
        where: { status: 'PENDING_APPROVAL' },
      }),
    ]);

    return { items, total, page, limit };
  }

  async approveRequest(requestId: string, superAdminId: string) {
    const request = await (
      this.prisma as any
    ).adminEmailChangeRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) throw new NotFoundException('Request not found');
    if (request.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException('Request is no longer pending approval');
    }

    // Check new email still available
    const taken = await (this.prisma as any).user.findFirst({
      where: {
        OR: [{ email: request.newEmail }, { pendingEmail: request.newEmail }],
        id: { not: request.adminId },
      },
      select: { id: true },
    });
    if (taken) {
      throw new BadRequestException(
        'The requested email address is no longer available. Ask the admin to submit a new request.',
      );
    }

    // Update the admin's email
    await this.prisma.$transaction([
      (this.prisma as any).user.update({
        where: { id: request.adminId },
        data: {
          email: request.newEmail,
          pendingEmail: null,
          pendingEmailTokenHash: null,
          pendingEmailExpiresAt: null,
          isEmailVerified: true,
        },
      }),
      (this.prisma as any).adminEmailChangeRequest.update({
        where: { id: requestId },
        data: {
          status: 'APPROVED',
          reviewedById: superAdminId,
          reviewedAt: new Date(),
        },
      }),
    ]);

    const NT_ADMIN_EMAIL_CHANGE_APPROVED =
      'ADMIN_EMAIL_CHANGE_APPROVED' as NotificationType;
    await this.notificationsService.create(
      request.adminId,
      NT_ADMIN_EMAIL_CHANGE_APPROVED,
      {
        actorId: superAdminId,
        payload: { newEmail: request.newEmail },
      },
    );

    const emailContent = emailTemplates.adminEmailChangeApprovedEmail(
      request.newEmail,
      request.currentEmail,
      this.emailService.getAppName(),
    );
    await this.emailService.send(
      request.newEmail,
      emailContent.subject,
      emailContent.html,
      emailContent.text,
      {
        recipientUserId: request.adminId,
        scenarioKey: 'admin.email_change.approved',
        priority: EmailPriority.P0_SECURITY,
        idempotencyKey: `admin:email-change:approved:${requestId}`,
      },
    );

    return { message: 'Email change approved and applied' };
  }

  async rejectRequest(requestId: string, superAdminId: string, reason: string) {
    const request = await (
      this.prisma as any
    ).adminEmailChangeRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) throw new NotFoundException('Request not found');
    if (request.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException('Request is no longer pending approval');
    }

    await (this.prisma as any).adminEmailChangeRequest.update({
      where: { id: requestId },
      data: {
        status: 'REJECTED',
        rejectionReason: reason || null,
        reviewedById: superAdminId,
        reviewedAt: new Date(),
      },
    });

    const NT_ADMIN_EMAIL_CHANGE_REJECTED =
      'ADMIN_EMAIL_CHANGE_REJECTED' as NotificationType;
    await this.notificationsService.create(
      request.adminId,
      NT_ADMIN_EMAIL_CHANGE_REJECTED,
      {
        actorId: superAdminId,
        payload: { newEmail: request.newEmail, reason },
      },
    );

    const emailContent = emailTemplates.adminEmailChangeRejectedEmail(
      request.newEmail,
      reason,
      this.emailService.getAppName(),
    );
    await this.emailService.send(
      request.currentEmail,
      emailContent.subject,
      emailContent.html,
      emailContent.text,
      {
        recipientUserId: request.adminId,
        scenarioKey: 'admin.email_change.rejected',
        priority: EmailPriority.P0_SECURITY,
        idempotencyKey: `admin:email-change:rejected:${requestId}`,
      },
    );

    return { message: 'Email change request rejected' };
  }
}
