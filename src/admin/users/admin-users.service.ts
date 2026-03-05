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
  AdminAuditAction,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';
import {
  DEFAULT_ADMIN_PERMISSIONS,
  AdminPermissionCode,
} from '../constants/permissions';
import { Request } from 'express';

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly userHelper: UserHelperService,
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
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          password: hashedPassword,
          role: targetRole,
          type: UserType.REGULAR,
          mustResetPassword: true,
          status: UserStatus.ACTIVE,
        },
        select: {
          id: true,
          username: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          createdAt: true,
        },
      });

      // Grant default permissions for Admin role
      if (targetRole === Role.Admin) {
        await tx.adminPermissionGrant.createMany({
          data: DEFAULT_ADMIN_PERMISSIONS.map((code) => ({
            id: uuidv4(),
            userId: created.id,
            permissionCode: code,
            grantedById: actorId,
          })),
        });
      }

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
        data: { role: newRole },
        select: { id: true, role: true, email: true },
      });

      // If promoted to Admin, grant default permissions
      if (newRole === Role.Admin && previousRole === Role.User) {
        await tx.adminPermissionGrant.createMany({
          data: DEFAULT_ADMIN_PERMISSIONS.map((code) => ({
            id: uuidv4(),
            userId: targetUserId,
            permissionCode: code,
            grantedById: actorId,
          })),
          skipDuplicates: true,
        });
      }

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
    permissions: AdminPermissionCode[],
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
      if (permissions.length > 0) {
        await tx.adminPermissionGrant.createMany({
          data: permissions.map((code) => ({
            id: uuidv4(),
            userId: targetUserId,
            permissionCode: code,
            grantedById: actorId,
          })),
        });
      }

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_USER_PERMISSION_UPDATE,
          targetType: 'User',
          targetId: targetUserId,
          previousState: { permissions: currentCodes },
          newState: { permissions },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    });

    // Revoke refresh tokens to force re-auth with new permissions
    await this.tokenService.revokeAllRefreshTokens(targetUserId);

    return { message: 'Permissions updated', permissions };
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

    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: targetUserId },
        data: updateData,
        select: { id: true, status: true, email: true, role: true },
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

    return updated;
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
      select: { id: true, role: true },
    });
    if (!target) throw new NotFoundException('User not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: targetUserId },
        data: { mustResetPassword: true },
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

    return { message: 'User must reset password on next login' };
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
  }) {
    const take = Math.min(params.limit ?? 50, 100);
    const where: Record<string, unknown> = {};

    if (params.role) where.role = params.role;
    if (params.status) where.status = params.status;
    if (params.search) {
      where.OR = [
        { email: { contains: params.search, mode: 'insensitive' } },
        { firstName: { contains: params.search, mode: 'insensitive' } },
        { lastName: { contains: params.search, mode: 'insensitive' } },
        { username: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const items = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        username: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        type: true,
        status: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(params.cursor
        ? { cursor: { id: params.cursor }, skip: 1 }
        : {}),
    });

    const hasMore = items.length > take;
    const results = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

    return { items: results, nextCursor };
  }

  /**
   * Get a single user by ID.
   */
  async getById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        type: true,
        status: true,
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
    if (!user) throw new NotFoundException('User not found');

    return {
      ...user,
      permissions: user.adminPermissionGrants.map((g) => g.permissionCode),
      adminPermissionGrants: undefined,
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
}
