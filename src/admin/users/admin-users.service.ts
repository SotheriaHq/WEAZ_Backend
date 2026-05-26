import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditService } from '../services/admin-audit.service';
import { PasswordService } from 'src/auth/helper/password.service';
import { TokenService } from 'src/auth/helper/general.helper';
import { UserHelperService } from 'src/auth/helper/user-helper.service';
import {
  Role,
  UserType,
  UserStatus,
  ReactivationRequestStatus,
  AdminAuditAction,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';
import {
  ALL_PERMISSION_CODES,
  AdminPermissionCode,
  SUPERADMIN_ONLY_PERMISSIONS,
} from '../constants/permissions';
import { Request } from 'express';
import { EmailService } from 'src/email/email.service';
import * as emailTemplates from 'src/email/email.templates';
import { resolveWebAppBaseUrl } from 'src/common/utils/web-app-url';
import {
  adminUserDisplaySelect,
  mapAdminUserDisplay,
} from '../admin-user-display.helper';

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);
  private readonly defaultSeededDeletableEmails = new Set<string>([
    'brand@example.com',
    'adminoversee@test.com',
  ]);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly userHelper: UserHelperService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Create a new admin account. SuperAdmin only.
   * Generates a temporary password that must be reset on first login.
   */
  async createAdmin(
    dto: {
      email: string;
      firstName: string;
      lastName: string;
      role?: Role;
    },
    actorId: string,
    req: Request,
  ) {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new BadRequestException('Email already exists');
    }

    const targetRole = dto.role === Role.SuperAdmin ? Role.SuperAdmin : Role.Admin;

    // Generate temporary password
    const tempPassword = randomBytes(16).toString('base64url');
    const hashedPassword = await this.passwordService.hashPassword(tempPassword);

    const username = await this.userHelper.generateUniqueUsername(
      dto.firstName.trim(),
      dto.lastName.trim(),
    );

    const userId = uuidv4();

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          id: userId,
          username,
          email: normalizedEmail,
          password: hashedPassword,
          role: targetRole,
          type: UserType.REGULAR,
          mustResetPassword: true,
          status: UserStatus.ACTIVE,
          userProfile: {
            create: {
              firstName: dto.firstName.trim(),
              lastName: dto.lastName.trim(),
            },
          },
        },
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
          userProfile: true,
        },
      });

      // New Admin users start with zero permissions; SuperAdmin grants explicitly.

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_USER_CREATE,
          targetType: 'User',
          targetId: created.id,
          newState: { email: created.email, role: created.role },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return created;
    });

    // Send admin account creation email with temporary password
    const loginUrl = `${resolveWebAppBaseUrl()}/admin/login`;
    const creationEmail = emailTemplates.adminAccountCreatedEmail(
      dto.email,
      tempPassword,
      loginUrl,
      this.emailService.getAppName(),
    );
    void this.emailService
      .send(dto.email, creationEmail.subject, creationEmail.html, creationEmail.text)
      .catch(() => undefined);

    return {
      user,
      temporaryPassword: tempPassword,
      message: 'Admin account created. User must reset password on first login.',
    };
  }

  /**
   * Update user role. SuperAdmin only.
   * Includes last-SuperAdmin protection.
   */
  async updateRole(
    targetUserId: string,
    newRole: Role,
    actorId: string,
    req: Request,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true, email: true },
    });
    if (!target) throw new NotFoundException('User not found');

    // Prevent demoting last SuperAdmin
    if (target.role === Role.SuperAdmin && newRole !== Role.SuperAdmin) {
      const superAdminCount = await this.prisma.user.count({
        where: { role: Role.SuperAdmin, status: UserStatus.ACTIVE },
      });
      if (superAdminCount <= 1) {
        throw new ForbiddenException(
          'Cannot demote the last active SuperAdmin',
        );
      }
    }

    const previousRole = target.role;

    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: targetUserId },
        data: {
          role: newRole,
          authVersion: { increment: 1 },
        },
        select: { id: true, role: true, email: true },
      });

      // If promoted to Admin, permissions remain explicit (no auto-grants).

      // If demoted from Admin, revoke all permissions
      if (
        previousRole === Role.Admin &&
        (newRole === Role.User || newRole === Role.SuperAdmin)
      ) {
        await tx.adminPermissionGrant.deleteMany({
          where: { userId: targetUserId },
        });
      }

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_USER_ROLE_UPDATE,
          targetType: 'User',
          targetId: targetUserId,
          previousState: { role: previousRole },
          newState: { role: newRole },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return user;
    });

    // Revoke all refresh tokens to force re-auth with new permissions
    await this.tokenService.revokeAllRefreshTokens(targetUserId);

    return updated;
  }

  /**
   * Update permissions for an Admin user. SuperAdmin only.
   */
  async updatePermissions(
    targetUserId: string,
    permissions: string[],
    actorId: string,
    req: Request,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.role !== Role.Admin) {
      throw new BadRequestException(
        'Permissions can only be managed for Admin role users',
      );
    }

    const normalizedPermissions = Array.from(
      new Set((permissions ?? []).map((p) => String(p).trim()).filter(Boolean)),
    );

    const invalidPermissions = normalizedPermissions.filter(
      (code) => !ALL_PERMISSION_CODES.includes(code as AdminPermissionCode),
    );
    if (invalidPermissions.length > 0) {
      throw new BadRequestException(
        `Unknown permission code(s): ${invalidPermissions.join(', ')}`,
      );
    }

    const disallowedAdminPermissions = normalizedPermissions.filter((code) =>
      SUPERADMIN_ONLY_PERMISSIONS.includes(code as AdminPermissionCode),
    );
    if (disallowedAdminPermissions.length > 0) {
      throw new BadRequestException(
        `Cannot assign SuperAdmin-only permissions to Admin users: ${disallowedAdminPermissions.join(', ')}`,
      );
    }

    const currentGrants = await this.prisma.adminPermissionGrant.findMany({
      where: { userId: targetUserId },
      select: { permissionCode: true },
    });
    const currentCodes = currentGrants.map((g) => g.permissionCode);

    await this.prisma.$transaction(async (tx) => {
      // Remove all current grants
      await tx.adminPermissionGrant.deleteMany({
        where: { userId: targetUserId },
      });

      // Insert new grants
      if (normalizedPermissions.length > 0) {
        await tx.adminPermissionGrant.createMany({
          data: normalizedPermissions.map((code) => ({
            id: uuidv4(),
            userId: targetUserId,
            permissionCode: code,
            grantedById: actorId,
          })),
        });
      }

      await tx.user.update({
        where: { id: targetUserId },
        data: { authVersion: { increment: 1 } },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_USER_PERMISSION_UPDATE,
          targetType: 'User',
          targetId: targetUserId,
          previousState: { permissions: currentCodes },
          newState: { permissions: normalizedPermissions },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    });

    // Revoke refresh tokens to force re-auth with new permissions
    await this.tokenService.revokeAllRefreshTokens(targetUserId);

    return { message: 'Permissions updated', permissions: normalizedPermissions };
  }

  /**
   * Update user status (activate/suspend/deactivate).
   */
  async updateStatus(
    targetUserId: string,
    newStatus: UserStatus,
    reason: string | undefined,
    actorId: string,
    actorRole: Role,
    req: Request,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, status: true, role: true },
    });
    if (!target) throw new NotFoundException('User not found');

    // Validate transition per state machine
    this.validateStatusTransition(target.status, newStatus, actorRole);

    // Non-SuperAdmin cannot change admin account status
    if (
      actorRole !== Role.SuperAdmin &&
      (target.role === Role.Admin || target.role === Role.SuperAdmin)
    ) {
      throw new ForbiddenException('Only SuperAdmin can change admin account status');
    }

    // Prevent self-deactivation of last SuperAdmin
    if (target.role === Role.SuperAdmin && newStatus !== UserStatus.ACTIVE) {
      const count = await this.prisma.user.count({
        where: { role: Role.SuperAdmin, status: UserStatus.ACTIVE },
      });
      if (count <= 1) {
        throw new ForbiddenException('Cannot deactivate the last active SuperAdmin');
      }
    }

    const previousStatus = target.status;
    const now = new Date();

    const updateData: Record<string, unknown> = { status: newStatus };
    if (newStatus === UserStatus.SUSPENDED) {
      updateData.adminSuspendedAt = now;
      updateData.adminSuspendedReason = reason ?? null;
    }
    if (newStatus === UserStatus.DEACTIVATED) {
      updateData.deactivatedAt = now;
      updateData.deactivatedReason = reason ?? null;
      updateData.isActive = 'Inactive';
    }
    if (newStatus === UserStatus.ACTIVE) {
      updateData.adminSuspendedAt = null;
      updateData.adminSuspendedReason = null;
      updateData.deactivatedAt = null;
      updateData.deactivatedReason = null;
      updateData.isActive = 'Active';
    }
    updateData.authVersion = { increment: 1 };

    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: targetUserId },
        data: updateData,
        select: adminUserDisplaySelect,
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_USER_STATUS_UPDATE,
          targetType: 'User',
          targetId: targetUserId,
          previousState: { status: previousStatus },
          newState: { status: newStatus, reason },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return user;
    });

    // If suspended or deactivated, revoke all tokens
    if (newStatus !== UserStatus.ACTIVE) {
      await this.tokenService.revokeAllRefreshTokens(targetUserId);
    }

    // Send status change email notification
    if (updated.email) {
      const appName = this.emailService.getAppName();
      if (newStatus === UserStatus.SUSPENDED) {
        const display = mapAdminUserDisplay(updated);
        const mail = emailTemplates.accountSuspendedEmail(display.firstName || 'User', reason || '', appName);
        void this.emailService.send(updated.email, mail.subject, mail.html, mail.text).catch(() => undefined);
      } else if (newStatus === UserStatus.ACTIVE && previousStatus !== UserStatus.ACTIVE) {
        const display = mapAdminUserDisplay(updated);
        const mail = emailTemplates.accountReactivatedEmail(display.firstName || 'User', appName);
        void this.emailService.send(updated.email, mail.subject, mail.html, mail.text).catch(() => undefined);
      }
    }

    return mapAdminUserDisplay(updated);
  }

  /**
   * Force password reset for an admin user.
   */
  async forcePasswordReset(
    targetUserId: string,
    actorId: string,
    req: Request,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true, email: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.role !== Role.Admin) {
      throw new BadRequestException('Force password reset with temporary password is limited to Admin users');
    }

    const tempPassword = randomBytes(16).toString('base64url');
    const hashedPassword = await this.passwordService.hashPassword(tempPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: targetUserId },
        data: {
          password: hashedPassword,
          mustResetPassword: true,
          authVersion: { increment: 1 },
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_USER_FORCE_PASSWORD_RESET,
          targetType: 'User',
          targetId: targetUserId,
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    });

    await this.tokenService.revokeAllRefreshTokens(targetUserId);

    return {
      email: target.email,
      temporaryPassword: tempPassword,
      message: 'Temporary password generated. User must reset password on next login.',
    };
  }

  async reissueTempPasswordForAdmin(
    targetUserId: string,
    verification: {
      actorEmail: string;
      actorUserIdConfirm: string;
      targetUserIdConfirm: string;
    },
    actorId: string,
    actorEmailFromToken: string,
    req: Request,
  ) {
    if (verification.actorUserIdConfirm !== actorId) {
      throw new ForbiddenException('Actor ID confirmation mismatch');
    }
    if (verification.targetUserIdConfirm !== targetUserId) {
      throw new ForbiddenException('Target user confirmation mismatch');
    }
    if (verification.actorEmail.trim().toLowerCase() !== actorEmailFromToken.trim().toLowerCase()) {
      throw new ForbiddenException('Actor email verification failed');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true, email: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.role !== Role.Admin) {
      throw new BadRequestException('Temporary password reissue is limited to Admin users');
    }

    const tempPassword = randomBytes(16).toString('base64url');
    const hashedPassword = await this.passwordService.hashPassword(tempPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: targetUserId },
        data: {
          password: hashedPassword,
          mustResetPassword: true,
          authVersion: { increment: 1 },
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_USER_FORCE_PASSWORD_RESET,
          targetType: 'User',
          targetId: targetUserId,
          previousState: null,
          newState: {
            reissuedTemporaryPassword: true,
            securityVerification: {
              actorEmailVerified: true,
              actorUserIdConfirmed: true,
              targetUserIdConfirmed: true,
            },
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    });

    await this.tokenService.revokeAllRefreshTokens(targetUserId);

    return {
      email: target.email,
      temporaryPassword: tempPassword,
      message: 'Temporary password reissued. Share securely and rotate after first login.',
    };
  }

  /**
   * List users with cursor-based pagination and filters.
   */
  async list(params: {
    cursor?: string;
    limit?: number;
    role?: Role;
    status?: UserStatus;
    search?: string;
    sort?: 'created_asc' | 'created_desc';
  }) {
    const take = Math.min(params.limit ?? 50, 100);
    const where: Record<string, unknown> = {
      role: { not: Role.SuperAdmin },
    };

    if (params.role === Role.SuperAdmin) {
      return { items: [], nextCursor: undefined };
    }
    if (params.role) where.role = params.role;
    if (params.status) where.status = params.status;
    if (params.search) {
      where.OR = [
        { email: { contains: params.search, mode: 'insensitive' } },
        { userProfile: { is: { firstName: { contains: params.search, mode: 'insensitive' } } } },
        { userProfile: { is: { lastName: { contains: params.search, mode: 'insensitive' } } } },
        { username: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const orderDir = params.sort === 'created_asc' ? 'asc' : 'desc';
    const items = await this.prisma.user.findMany({
      where,
      select: {
        ...adminUserDisplaySelect,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: orderDir }, { id: orderDir }],
      take: take + 1,
      ...(params.cursor
        ? { cursor: { id: params.cursor }, skip: 1 }
        : {}),
    });

    const hasMore = items.length > take;
    const results = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

    return {
      items: results.map((item) => mapAdminUserDisplay(item)),
      nextCursor,
    };
  }

  /**
   * Get a single user by ID.
   */
  async getById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        ...adminUserDisplaySelect,
        isActive: true,
        mustResetPassword: true,
        adminSuspendedAt: true,
        adminSuspendedReason: true,
        deactivatedAt: true,
        deactivatedReason: true,
        createdAt: true,
        updatedAt: true,
        brand: { select: { id: true, name: true, isStoreOpen: true } },
        adminPermissionGrants: {
          select: { permissionCode: true },
        },
      },
    });
    if (!user || user.role === Role.SuperAdmin) {
      throw new NotFoundException('User not found');
    }

    return {
      ...mapAdminUserDisplay(user),
      permissions: user.adminPermissionGrants.map((g) => g.permissionCode),
      adminPermissionGrants: undefined,
    };
  }

  async listReactivationRequests(params: {
    cursor?: string;
    limit?: number;
    status?: 'PENDING' | 'APPROVED' | 'REJECTED';
    email?: string;
  }) {
    const take = Math.min(params.limit ?? 50, 100);
    const where: Record<string, unknown> = {
      user: {
        role: {
          not: Role.SuperAdmin,
        },
      },
    };

    if (params.status) {
      where.status = params.status;
    }
    if (params.email) {
      where.emailSnapshot = {
        contains: params.email.trim(),
        mode: 'insensitive',
      };
    }

    const items = await this.prisma.accountReactivationRequest.findMany({
      where,
      take: take + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      include: {
        user: {
          select: adminUserDisplaySelect,
        },
        reviewedBy: {
          select: adminUserDisplaySelect,
        },
      },
    });

    const hasMore = items.length > take;
    const results = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

    return {
      items: results.map((item) => ({
        ...item,
        user: mapAdminUserDisplay(item.user),
        reviewedBy: mapAdminUserDisplay(item.reviewedBy),
      })),
      nextCursor,
    };
  }

  async reviewReactivationRequest(
    requestId: string,
    decision: { decision: 'APPROVE' | 'REJECT'; adminNote?: string },
    actorId: string,
    actorRole: Role,
    req: Request,
  ) {
    const request = await this.prisma.accountReactivationRequest.findUnique({
      where: { id: requestId },
      include: {
        user: {
          select: {
            ...adminUserDisplaySelect,
            isActive: true,
          },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('Reactivation request not found');
    }

    if (request.status !== ReactivationRequestStatus.PENDING) {
      throw new BadRequestException('Reactivation request has already been reviewed');
    }

    const adminNote = decision.adminNote?.trim() || null;

    if (decision.decision === 'REJECT') {
      const rejected = await this.prisma.$transaction(async (tx) => {
        const result = await tx.accountReactivationRequest.update({
          where: { id: requestId },
          data: {
            status: ReactivationRequestStatus.REJECTED,
            adminNote,
            reviewedById: actorId,
            reviewedAt: new Date(),
          },
        });

        await (tx as any).adminAuditLog.create({
          data: {
            id: uuidv4(),
            actorUserId: actorId,
            action: AdminAuditAction.ADMIN_USER_STATUS_UPDATE,
            targetType: 'AccountReactivationRequest',
            targetId: requestId,
            previousState: { status: request.status },
            newState: {
              status: ReactivationRequestStatus.REJECTED,
              adminNote,
            },
            ipAddress: req.socket?.remoteAddress ?? null,
            userAgent: req.headers['user-agent'] ?? null,
          },
        });

        return result;
      });

      return {
        message: 'Reactivation request rejected',
        request: rejected,
      };
    }

    // APPROVE path
    if (
      request.user.role !== Role.User &&
      actorRole !== Role.SuperAdmin
    ) {
      throw new ForbiddenException(
        'Only SuperAdmin can reactivate admin/superadmin accounts',
      );
    }

    if (
      request.user.status === UserStatus.DEACTIVATED &&
      actorRole !== Role.SuperAdmin
    ) {
      throw new ForbiddenException(
        'Only SuperAdmin can reactivate deactivated accounts',
      );
    }

    const approved = await this.prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: request.user.id },
        data: {
          status: UserStatus.ACTIVE,
          isActive: 'Active',
          adminSuspendedAt: null,
          adminSuspendedReason: null,
          deactivatedAt: null,
          deactivatedReason: null,
          authVersion: { increment: 1 },
        },
        select: { id: true, status: true, role: true },
      });

      const updatedRequest = await tx.accountReactivationRequest.update({
        where: { id: requestId },
        data: {
          status: ReactivationRequestStatus.APPROVED,
          adminNote,
          reviewedById: actorId,
          reviewedAt: new Date(),
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_USER_STATUS_UPDATE,
          targetType: 'User',
          targetId: request.user.id,
          previousState: { status: request.user.status },
          newState: {
            status: UserStatus.ACTIVE,
            source: 'reactivation_request',
            requestId,
            adminNote,
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return { updatedRequest, updatedUser };
    });

    await this.tokenService.revokeAllRefreshTokens(request.user.id);

    // Notify user their account has been reactivated
    if (request.user.email) {
      const requestUser = mapAdminUserDisplay(request.user);
      const mail = emailTemplates.accountReactivatedEmail(
        requestUser.firstName || 'User',
        this.emailService.getAppName(),
      );
      void this.emailService
        .send(request.user.email, mail.subject, mail.html, mail.text)
        .catch(() => undefined);
    }

    return {
      message: 'Reactivation request approved and account reactivated',
      request: approved.updatedRequest,
      user: approved.updatedUser,
    };
  }

  private validateStatusTransition(
    from: UserStatus,
    to: UserStatus,
    actorRole: Role,
  ) {
    if (from === to) return; // No-op

    const allowed: Record<UserStatus, UserStatus[]> = {
      [UserStatus.ACTIVE]: [UserStatus.SUSPENDED, UserStatus.DEACTIVATED],
      [UserStatus.SUSPENDED]: [UserStatus.ACTIVE, UserStatus.DEACTIVATED],
      [UserStatus.DEACTIVATED]: [UserStatus.ACTIVE],
    };

    if (!allowed[from]?.includes(to)) {
      throw new BadRequestException(
        `Invalid status transition from ${from} to ${to}`,
      );
    }

    // Deactivated → Active requires SuperAdmin
    if (from === UserStatus.DEACTIVATED && to === UserStatus.ACTIVE) {
      if (actorRole !== Role.SuperAdmin) {
        throw new ForbiddenException(
          'Only SuperAdmin can reactivate deactivated accounts',
        );
      }
    }
  }

  // ── GDPR ── Data Export ──
  private getSeededDeletableEmails(): Set<string> {
    const configured = String(process.env.SEEDED_USER_EMAILS || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    return new Set([
      ...Array.from(this.defaultSeededDeletableEmails),
      ...configured,
    ]);
  }

  private isSeededDeletableEmail(email: string): boolean {
    return this.getSeededDeletableEmails().has(email.trim().toLowerCase());
  }

  async hardDeleteSeededUser(
    targetUserId: string,
    actorId: string,
    req: Request,
  ) {
    if (targetUserId === actorId) {
      throw new BadRequestException('You cannot hard-delete your own account');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        ...adminUserDisplaySelect,
        brand: {
          select: { id: true },
        },
      },
    });
    if (!target) throw new NotFoundException('User not found');

    if (!this.isSeededDeletableEmail(target.email)) {
      throw new ForbiddenException(
        'Hard delete is only allowed for seeded users',
      );
    }

    const [
      ordersAsBuyerCount,
      disputesReportedCount,
      disputesAssignedCount,
      disputesResolvedCount,
    ] = await Promise.all([
      this.prisma.order.count({ where: { buyerId: targetUserId } }),
      this.prisma.dispute.count({ where: { reporterId: targetUserId } }),
      this.prisma.dispute.count({ where: { assignedToId: targetUserId } }),
      this.prisma.dispute.count({ where: { resolvedById: targetUserId } }),
    ]);

    if (ordersAsBuyerCount > 0) {
      throw new BadRequestException(
        'Cannot hard-delete seeded user with existing orders',
      );
    }
    if (
      disputesReportedCount > 0 ||
      disputesAssignedCount > 0 ||
      disputesResolvedCount > 0
    ) {
      throw new BadRequestException(
        'Cannot hard-delete seeded user with linked disputes',
      );
    }

    if (target.brand?.id) {
      const [brandOrdersCount, brandOrderItemsCount, brandPayoutCount] =
        await Promise.all([
          this.prisma.order.count({ where: { brandId: target.brand.id } }),
          this.prisma.orderItem.count({ where: { brandId: target.brand.id } }),
          this.prisma.payout.count({ where: { brandId: target.brand.id } }),
        ]);

      if (
        brandOrdersCount > 0 ||
        brandOrderItemsCount > 0 ||
        brandPayoutCount > 0
      ) {
        throw new BadRequestException(
          'Cannot hard-delete seeded brand user with order or payout history',
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.accountReactivationRequest.updateMany({
        where: { reviewedById: targetUserId },
        data: { reviewedById: null },
      });

      await tx.adminPermissionGrant.deleteMany({
        where: { grantedById: targetUserId },
      });

      if (target.brand?.id) {
        await tx.storePolicy.deleteMany({
          where: { brandId: target.brand.id },
        });
        await tx.brand.delete({
          where: { id: target.brand.id },
        });
      }

      await tx.user.delete({
        where: { id: targetUserId },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_USER_DATA_WIPE,
          targetType: 'User',
          targetId: targetUserId,
          previousState: {
            email: target.email,
            role: target.role,
            mode: 'hard_delete_seeded',
          },
          newState: {
            deletedAt: new Date().toISOString(),
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    });

    await this.tokenService.revokeAllRefreshTokens(targetUserId);

    return {
      success: true,
      message: 'Seeded user hard-deleted successfully',
      user: {
        id: target.id,
        email: target.email,
        name: `${mapAdminUserDisplay(target).firstName} ${mapAdminUserDisplay(target).lastName}`.trim(),
      },
    };
  }

  async dataExport(userId: string, actorId: string, req: Request) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        brand: true,
        collections: { take: 100 },
        ordersAsBuyer: { take: 100 },
        notificationsReceived: { take: 50, orderBy: { createdAt: 'desc' } },
        disputesReported: { take: 50 },
      },
    });

    if (!user) throw new NotFoundException('User not found');

    const [threadParticipants, sentMessages, threadOutbox] = await Promise.all([
      this.prisma.messageThreadParticipant.findMany({
        where: { userId },
        include: {
          thread: {
            select: {
              id: true,
              contextType: true,
              orderId: true,
              customOrderId: true,
              status: true,
              lastMessageAt: true,
            },
          },
        },
        take: 200,
        orderBy: { joinedAt: 'desc' },
      }),
      this.prisma.message.findMany({
        where: { senderUserId: userId },
        select: {
          id: true,
          threadId: true,
          senderRole: true,
          kind: true,
          visibilityState: true,
          bodyText: true,
          createdAt: true,
          moderatedAt: true,
        },
        take: 200,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.messageNotificationOutbox.findMany({
        where: { recipientId: userId },
        select: {
          id: true,
          threadId: true,
          messageId: true,
          notificationType: true,
          status: true,
          attempts: true,
          availableAt: true,
          processedAt: true,
          createdAt: true,
        },
        take: 200,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const sentMessageIds = sentMessages.map((message) => message.id);
    const sentMessageAttachments = sentMessageIds.length
      ? await this.prisma.messageAttachment.findMany({
          where: { messageId: { in: sentMessageIds } },
          select: {
            id: true,
            messageId: true,
            kind: true,
            createdAt: true,
            file: {
              select: {
                id: true,
                originalName: true,
                fileType: true,
                mimeType: true,
                size: true,
                createdAt: true,
              },
            },
          },
        })
      : [];

    const attachmentsByMessageId = sentMessageAttachments.reduce<Record<string, typeof sentMessageAttachments>>((acc, attachment) => {
      if (!acc[attachment.messageId]) {
        acc[attachment.messageId] = [];
      }
      acc[attachment.messageId].push(attachment);
      return acc;
    }, {});

    const sentMessagesWithAttachments = sentMessages.map((message) => ({
      ...message,
      attachments: attachmentsByMessageId[message.id] ?? [],
    }));

    await (this.prisma as any).adminAuditLog.create({
      data: {
        id: uuidv4(),
        actorUserId: actorId,
        action: AdminAuditAction.ADMIN_USER_DATA_EXPORT,
        targetType: 'User',
        targetId: userId,
        previousState: null,
        newState: { exportedAt: new Date().toISOString() },
        ipAddress: req.socket?.remoteAddress ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      },
    });

    // Strip sensitive fields
    const { password, refreshTokens, authVersion, ...safeUser } = user as any;

    return {
      exportedAt: new Date().toISOString(),
      user: safeUser,
      messaging: {
        threadParticipants,
        sentMessages: sentMessagesWithAttachments,
        outboxEvents: threadOutbox,
      },
    };
  }

  // ── GDPR ── Data Wipe ──
  async dataWipe(userId: string, actorId: string, req: Request) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, status: true },
    });

    if (!user) throw new NotFoundException('User not found');

    // Audit BEFORE deletion
    await (this.prisma as any).adminAuditLog.create({
      data: {
        id: uuidv4(),
        actorUserId: actorId,
        action: AdminAuditAction.ADMIN_USER_DATA_WIPE,
        targetType: 'User',
        targetId: userId,
        previousState: { email: user.email, status: user.status },
        newState: { wipedAt: new Date().toISOString() },
        ipAddress: req.socket?.remoteAddress ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      },
    });

    const counts = {
      orders: 0,
      collections: 0,
      notifications: 0,
      disputes: 0,
      messageThreadParticipants: 0,
      messageOutboxEvents: 0,
      messagesRedacted: 0,
      threadBuyerSlotsCleared: 0,
      messageAttachmentsDeleted: 0,
      messageAttachmentFilesDeleted: 0,
    };

    await this.prisma.$transaction(async (tx) => {
      // Delete related entities
      const orders = await tx.order.deleteMany({ where: { buyerId: userId } });
      counts.orders = orders.count;

      const collections = await tx.collection.deleteMany({ where: { ownerId: userId } });
      counts.collections = collections.count;

      const notifications = await tx.notification.deleteMany({ where: { recipientId: userId } });
      counts.notifications = notifications.count;

      const disputes = await tx.dispute.deleteMany({
        where: { reporterId: userId },
      });
      counts.disputes = disputes.count;

      const messageThreadParticipants = await tx.messageThreadParticipant.deleteMany({
        where: { userId },
      });
      counts.messageThreadParticipants = messageThreadParticipants.count;

      const messageOutboxEvents = await tx.messageNotificationOutbox.deleteMany({
        where: { recipientId: userId },
      });
      counts.messageOutboxEvents = messageOutboxEvents.count;

      const userMessages = await tx.message.findMany({
        where: { senderUserId: userId },
        select: { id: true },
      });
      const userMessageIds = userMessages.map((message) => message.id);

      if (userMessageIds.length > 0) {
        const attachments = await tx.messageAttachment.findMany({
          where: { messageId: { in: userMessageIds } },
          select: {
            id: true,
            fileUploadId: true,
            file: {
              select: {
                userId: true,
              },
            },
          },
        });

        const attachmentIds = attachments.map((attachment) => attachment.id);
        const ownedAttachmentFileIds = Array.from(
          new Set(
            attachments
              .filter((attachment) => attachment.file.userId === userId)
              .map((attachment) => attachment.fileUploadId),
          ),
        );

        if (attachmentIds.length > 0) {
          const messageAttachmentsDeleted = await tx.messageAttachment.deleteMany({
            where: { id: { in: attachmentIds } },
          });
          counts.messageAttachmentsDeleted = messageAttachmentsDeleted.count;
        }

        if (ownedAttachmentFileIds.length > 0) {
          const messageAttachmentFilesDeleted = await tx.fileUpload.deleteMany({
            where: { id: { in: ownedAttachmentFileIds }, userId },
          });
          counts.messageAttachmentFilesDeleted = messageAttachmentFilesDeleted.count;
        }
      }

      const messagesRedacted = await tx.message.updateMany({
        where: { senderUserId: userId },
        data: {
          senderUserId: null,
          bodyText: null,
          visibilityState: 'REDACTED',
          moderatedAt: new Date(),
          moderationReason: 'USER_DATA_WIPE',
        },
      });
      counts.messagesRedacted = messagesRedacted.count;

      const threadBuyerSlotsCleared = await tx.messageThread.updateMany({
        where: { buyerId: userId },
        data: { buyerId: null },
      });
      counts.threadBuyerSlotsCleared = threadBuyerSlotsCleared.count;

      // Anonymize user record
      await tx.user.update({
        where: { id: userId },
        data: {
          email: `deleted-${userId.slice(0, 8)}@erased.local`,
          username: `deleted-${userId.slice(0, 8)}`,
          password: '',
          status: UserStatus.DEACTIVATED,
          isActive: 'Inactive',
          authVersion: { increment: 1 },
          userProfile: {
            update: {
              firstName: 'Deleted',
              lastName: 'User',
              phoneNumber: null,
              profileImage: null,
              bannerImage: null,
              address: null,
            },
          },
        },
      });
    });

    await this.tokenService.revokeAllRefreshTokens(userId);

    return {
      message: 'User data permanently erased',
      erasedEntities: counts,
    };
  }

  async permanentlyDeleteDeactivatedAdminUser(
    targetUserId: string,
    actorId: string,
    req: Request,
  ) {
    if (targetUserId === actorId) {
      throw new BadRequestException('You cannot permanently delete your own account');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        brand: { select: { id: true } },
      },
    });

    if (!target) throw new NotFoundException('User not found');
    if (target.role !== Role.Admin) {
      throw new BadRequestException('Permanent delete is limited to Admin users');
    }
    if (target.status !== UserStatus.DEACTIVATED) {
      throw new BadRequestException('Admin must be deactivated before permanent delete');
    }
    if (target.brand?.id) {
      throw new BadRequestException('Cannot permanently delete admin user linked to a brand');
    }

    const nowIso = new Date().toISOString();

    await this.prisma.$transaction(async (tx) => {
      await tx.adminPermissionGrant.deleteMany({ where: { userId: targetUserId } });
      await tx.accountReactivationRequest.deleteMany({ where: { userId: targetUserId } });
      await tx.refreshToken.deleteMany({ where: { userId: targetUserId } });
      await tx.notification.deleteMany({ where: { recipientId: targetUserId } });
      await tx.messageNotificationOutbox.deleteMany({ where: { recipientId: targetUserId } });
      await tx.messageThreadParticipant.deleteMany({ where: { userId: targetUserId } });

      await tx.message.updateMany({
        where: { senderUserId: targetUserId },
        data: {
          senderUserId: null,
          bodyText: null,
          visibilityState: 'REDACTED',
          moderatedAt: new Date(),
          moderationReason: 'ADMIN_USER_PERMANENT_DELETE',
        },
      });

      await tx.messageThread.updateMany({
        where: { buyerId: targetUserId },
        data: { buyerId: null },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_USER_DATA_WIPE,
          targetType: 'User',
          targetId: targetUserId,
          previousState: {
            email: target.email,
            role: target.role,
            status: target.status,
          },
          newState: {
            permanentlyDeleted: true,
            deletedAt: nowIso,
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      await tx.user.delete({ where: { id: targetUserId } });
    });

    return { message: 'Admin user permanently deleted' };
  }
}

