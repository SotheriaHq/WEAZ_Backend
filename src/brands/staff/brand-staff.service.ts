import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminAuditAction,
  BrandMemberRole,
  BrandMemberStatus,
  BrandStaffInviteStatus,
  Role,
} from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { BrandAccessService } from '../brand-access.service';
import { BrandPermissionService } from '../permissions/brand-permission.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';
import { EmailService } from 'src/email/email.service';
import * as emailTemplates from 'src/email/email.templates';
import { resolveAppUrl } from 'src/email/email.branding';
import {
  canonicalUserProfileSelect,
  resolveRequiredProfileField,
} from 'src/common/user-profile-source.helper';

const STAFF_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STAFF_MANAGED_ROLES = new Set<BrandMemberRole>([
  BrandMemberRole.MANAGER,
  BrandMemberRole.CATALOG_MANAGER,
  BrandMemberRole.ORDER_MANAGER,
  BrandMemberRole.SUPPORT_AGENT,
  BrandMemberRole.VIEWER,
]);
const STAFF_MANAGED_STATUSES = new Set<BrandMemberStatus>([
  BrandMemberStatus.ACTIVE,
  BrandMemberStatus.SUSPENDED,
  BrandMemberStatus.REMOVED,
]);
const STAFF_USER_SELECT = {
  id: true,
  email: true,
  username: true,
  userProfile: { select: canonicalUserProfileSelect },
  role: true,
  type: true,
  status: true,
} as const;
const BRAND_STAFF_AUDIT_ACTIONS = {
  INVITE_CREATE: 'BRAND_STAFF_INVITE_CREATE' as AdminAuditAction,
  INVITE_ACCEPT: 'BRAND_STAFF_INVITE_ACCEPT' as AdminAuditAction,
  INVITE_REJECT: 'BRAND_STAFF_INVITE_REJECT' as AdminAuditAction,
  INVITE_CANCEL: 'BRAND_STAFF_INVITE_CANCEL' as AdminAuditAction,
  ROLE_UPDATE: 'BRAND_STAFF_ROLE_UPDATE' as AdminAuditAction,
  STATUS_UPDATE: 'BRAND_STAFF_STATUS_UPDATE' as AdminAuditAction,
  PERMISSION_UPDATE: 'BRAND_STAFF_PERMISSION_UPDATE' as AdminAuditAction,
} as const;

@Injectable()
export class BrandStaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brandAccessService: BrandAccessService,
    private readonly brandPermissionService: BrandPermissionService,
    private readonly emailService: EmailService,
    private readonly adminAuditService: AdminAuditService,
  ) {}

  private normalizeEmail(email: string): string {
    const normalized = String(email ?? '')
      .trim()
      .toLowerCase();
    if (!normalized) {
      throw new BadRequestException('Email is required');
    }
    return normalized;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private assertAssignableStaffRole(role: BrandMemberRole): void {
    if (!STAFF_MANAGED_ROLES.has(role)) {
      throw new BadRequestException('This role cannot be assigned to staff');
    }
  }

  private assertManageableStatus(status: BrandMemberStatus): void {
    if (!STAFF_MANAGED_STATUSES.has(status)) {
      throw new BadRequestException('Invalid staff status transition');
    }
  }

  private mapMember(member: any) {
    return {
      id: member.id,
      userId: member.userId,
      email: member.user?.email ?? null,
      username: member.user?.username ?? null,
      firstName: member.user
        ? resolveRequiredProfileField(member.user, 'firstName') || null
        : null,
      lastName: member.user
        ? resolveRequiredProfileField(member.user, 'lastName') || null
        : null,
      role: member.role,
      status: member.status,
      joinedAt: member.joinedAt,
      invitedById: member.invitedById ?? null,
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
    };
  }

  private mapInvite(invite: any, includeToken?: string) {
    return {
      id: invite.id,
      brandId: invite.brandId,
      email: invite.email,
      role: invite.role,
      status: invite.status,
      invitedById: invite.invitedById,
      invitedUserId: invite.invitedUserId ?? null,
      expiresAt: invite.expiresAt,
      acceptedAt: invite.acceptedAt ?? null,
      rejectedAt: invite.rejectedAt ?? null,
      cancelledAt: invite.cancelledAt ?? null,
      createdAt: invite.createdAt,
      updatedAt: invite.updatedAt,
      ...(includeToken ? { inviteToken: includeToken } : {}),
    };
  }

  private getDisplayName(
    user?: {
      userProfile?: {
        firstName?: string | null;
        lastName?: string | null;
      } | null;
      username?: string | null;
      email?: string | null;
    } | null,
  ): string | null {
    if (!user) return null;
    const name = [user.userProfile?.firstName, user.userProfile?.lastName]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
      .join(' ');
    return name || user.username || user.email || null;
  }

  private buildInviteLink(token: string): string {
    return resolveAppUrl(
      `/brand/staff/invite?token=${encodeURIComponent(token)}`,
    );
  }

  private async queueInviteEmail(params: {
    invite: any;
    token: string;
    brandId: string;
    actorUserId: string;
  }) {
    try {
      const [brand, actor] = await Promise.all([
        this.prisma.brand.findUnique({
          where: { id: params.brandId },
          select: { name: true },
        }),
        this.prisma.user.findUnique({
          where: { id: params.actorUserId },
          select: {
            email: true,
            username: true,
            userProfile: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
          },
        }),
      ]);
      const inviteLink = this.buildInviteLink(params.token);
      const email = emailTemplates.brandStaffInviteEmail({
        brandName: brand?.name ?? 'WEAZ brand',
        inviterDisplayName: this.getDisplayName(actor),
        inviterEmail: actor?.email ?? null,
        role: params.invite.role,
        expiresAt: params.invite.expiresAt,
        inviteLink,
        appName: this.emailService.getAppName(),
      });

      return this.emailService.send(
        params.invite.email,
        email.subject,
        email.html,
        email.text,
        {
          scenarioKey: 'brand.staff.invite',
          payloadJson: {
            inviteId: params.invite.id,
            brandId: params.brandId,
            role: params.invite.role,
            expiresAt: params.invite.expiresAt,
          },
          idempotencyKey: `brand-staff-invite:${params.invite.id}`,
        },
      );
    } catch (error: any) {
      return {
        outboxId: null,
        dispatchStatus: 'FAILED' as const,
        providerMessageId: null,
        errorMessage: error?.message ?? String(error),
      };
    }
  }

  private async getMemberOrThrow(brandId: string, memberId: string) {
    const member = await this.prisma.brandMember.findUnique({
      where: { id: memberId },
      include: {
        user: { select: STAFF_USER_SELECT },
      },
    });

    if (!member || member.brandId !== brandId) {
      throw new NotFoundException('Brand member not found');
    }

    return member;
  }

  async listStaff(actorUserId: string, brandIdOrOwnerId: string) {
    const brandId =
      await this.brandAccessService.resolveBrandIdFromBrandOrOwnerId(
        brandIdOrOwnerId,
      );
    await this.brandAccessService.assertCanManageStaff(actorUserId, brandId);

    const [members, invites] = await Promise.all([
      this.prisma.brandMember.findMany({
        where: { brandId },
        include: {
          user: { select: STAFF_USER_SELECT },
        },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.brandStaffInvite.findMany({
        where: {
          brandId,
          status: {
            in: [
              BrandStaffInviteStatus.PENDING,
              BrandStaffInviteStatus.ACCEPTED,
              BrandStaffInviteStatus.REJECTED,
              BrandStaffInviteStatus.EXPIRED,
              BrandStaffInviteStatus.CANCELLED,
            ],
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      members: members.map((member) => this.mapMember(member)),
      invites: invites.map((invite) => this.mapInvite(invite)),
    };
  }

  async inviteStaff(
    actorUserId: string,
    brandIdOrOwnerId: string,
    input: { email: string; role: BrandMemberRole },
  ) {
    const brandId =
      await this.brandAccessService.resolveBrandIdFromBrandOrOwnerId(
        brandIdOrOwnerId,
      );
    await this.brandAccessService.assertCanManageStaff(actorUserId, brandId);
    this.assertAssignableStaffRole(input.role);

    const email = this.normalizeEmail(input.email);
    const invitedUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, role: true },
    });

    if (
      invitedUser &&
      (invitedUser.role === Role.Admin || invitedUser.role === Role.SuperAdmin)
    ) {
      throw new BadRequestException(
        'Platform admin accounts cannot be invited as brand staff',
      );
    }

    if (invitedUser) {
      const existingMember = await this.prisma.brandMember.findUnique({
        where: { brandId_userId: { brandId, userId: invitedUser.id } },
        select: { id: true, status: true },
      });
      if (existingMember?.status === BrandMemberStatus.ACTIVE) {
        throw new BadRequestException(
          'This user is already an active brand member',
        );
      }
    }

    const duplicatePending = await this.prisma.brandStaffInvite.findFirst({
      where: {
        brandId,
        email,
        status: BrandStaffInviteStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (duplicatePending) {
      throw new BadRequestException(
        'A pending invite already exists for this email',
      );
    }

    const token = randomBytes(32).toString('hex');
    const invite = await this.prisma.brandStaffInvite.create({
      data: {
        id: uuidv4(),
        brandId,
        email,
        role: input.role,
        status: BrandStaffInviteStatus.PENDING,
        tokenHash: this.hashToken(token),
        invitedById: actorUserId,
        invitedUserId: invitedUser?.id ?? null,
        expiresAt: new Date(Date.now() + STAFF_INVITE_TTL_MS),
      },
    });

    const emailDelivery = await this.queueInviteEmail({
      invite,
      token,
      brandId,
      actorUserId,
    });

    await this.adminAuditService.safeLog({
      actorUserId,
      action: BRAND_STAFF_AUDIT_ACTIONS.INVITE_CREATE,
      targetType: 'BrandStaffInvite',
      targetId: invite.id,
      metadata: {
        brandId,
        invitedEmail: email,
        invitedUserId: invitedUser?.id ?? null,
        role: input.role,
        emailDispatchStatus: emailDelivery.dispatchStatus,
        emailOutboxId: emailDelivery.outboxId,
      },
      newState: {
        status: invite.status,
        role: invite.role,
        expiresAt: invite.expiresAt,
      },
    });

    return {
      ...this.mapInvite(invite, token),
      emailDelivery,
    };
  }

  async cancelInvite(
    actorUserId: string,
    brandIdOrOwnerId: string,
    inviteId: string,
  ) {
    const brandId =
      await this.brandAccessService.resolveBrandIdFromBrandOrOwnerId(
        brandIdOrOwnerId,
      );
    await this.brandAccessService.assertCanManageStaff(actorUserId, brandId);

    const invite = await this.prisma.brandStaffInvite.findUnique({
      where: { id: inviteId },
    });
    if (!invite || invite.brandId !== brandId) {
      throw new NotFoundException('Brand staff invite not found');
    }
    if (invite.status !== BrandStaffInviteStatus.PENDING) {
      throw new BadRequestException('Only pending invites can be cancelled');
    }

    const updated = await this.prisma.brandStaffInvite.update({
      where: { id: invite.id },
      data: {
        status: BrandStaffInviteStatus.CANCELLED,
        cancelledAt: new Date(),
      },
    });
    await this.adminAuditService.safeLog({
      actorUserId,
      action: BRAND_STAFF_AUDIT_ACTIONS.INVITE_CANCEL,
      targetType: 'BrandStaffInvite',
      targetId: invite.id,
      metadata: {
        brandId,
        invitedEmail: invite.email,
        role: invite.role,
      },
      previousState: { status: invite.status },
      newState: { status: updated.status, cancelledAt: updated.cancelledAt },
    });
    return this.mapInvite(updated);
  }

  async acceptInvite(actorUserId: string, token: string) {
    const invite = await this.prisma.brandStaffInvite.findUnique({
      where: { tokenHash: this.hashToken(token) },
    });
    if (!invite) {
      throw new NotFoundException('Brand staff invite not found');
    }
    if (invite.status !== BrandStaffInviteStatus.PENDING || invite.acceptedAt) {
      throw new BadRequestException('This invite can no longer be accepted');
    }
    if (invite.expiresAt <= new Date()) {
      await this.prisma.brandStaffInvite.update({
        where: { id: invite.id },
        data: { status: BrandStaffInviteStatus.EXPIRED },
      });
      throw new BadRequestException('This invite has expired');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { id: true, email: true, role: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.email.trim().toLowerCase() !== invite.email) {
      throw new ForbiddenException(
        'This invite belongs to another email address',
      );
    }
    if (invite.invitedUserId && invite.invitedUserId !== user.id) {
      throw new ForbiddenException('This invite belongs to another user');
    }
    if (user.role === Role.Admin || user.role === Role.SuperAdmin) {
      throw new BadRequestException(
        'Platform admin accounts cannot accept brand staff invites',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const existingMember = await tx.brandMember.findUnique({
        where: {
          brandId_userId: {
            brandId: invite.brandId,
            userId: user.id,
          },
        },
      });

      const member = existingMember
        ? await tx.brandMember.update({
            where: { id: existingMember.id },
            data: {
              role: invite.role,
              status: BrandMemberStatus.ACTIVE,
              invitedById: invite.invitedById,
              joinedAt: existingMember.joinedAt ?? new Date(),
            },
            include: { user: { select: STAFF_USER_SELECT } },
          })
        : await tx.brandMember.create({
            data: {
              id: uuidv4(),
              brandId: invite.brandId,
              userId: user.id,
              role: invite.role,
              status: BrandMemberStatus.ACTIVE,
              invitedById: invite.invitedById,
              joinedAt: new Date(),
            },
            include: { user: { select: STAFF_USER_SELECT } },
          });

      await tx.brandStaffInvite.update({
        where: { id: invite.id },
        data: {
          status: BrandStaffInviteStatus.ACCEPTED,
          invitedUserId: user.id,
          acceptedAt: new Date(),
        },
      });

      await this.adminAuditService.safeLogInTransaction(tx, {
        actorUserId,
        action: BRAND_STAFF_AUDIT_ACTIONS.INVITE_ACCEPT,
        targetType: 'BrandStaffInvite',
        targetId: invite.id,
        metadata: {
          brandId: invite.brandId,
          invitedEmail: invite.email,
          memberId: member.id,
          role: invite.role,
        },
        previousState: { status: invite.status },
        newState: {
          status: BrandStaffInviteStatus.ACCEPTED,
          memberStatus: member.status,
          memberRole: member.role,
        },
      });

      return this.mapMember(member);
    });
  }

  async rejectInvite(actorUserId: string, token: string) {
    const invite = await this.prisma.brandStaffInvite.findUnique({
      where: { tokenHash: this.hashToken(token) },
    });
    if (!invite) {
      throw new NotFoundException('Brand staff invite not found');
    }
    if (invite.status !== BrandStaffInviteStatus.PENDING) {
      throw new BadRequestException('This invite can no longer be rejected');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { id: true, email: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.email.trim().toLowerCase() !== invite.email) {
      throw new ForbiddenException(
        'This invite belongs to another email address',
      );
    }

    const updated = await this.prisma.brandStaffInvite.update({
      where: { id: invite.id },
      data: {
        status: BrandStaffInviteStatus.REJECTED,
        invitedUserId: user.id,
        rejectedAt: new Date(),
      },
    });
    await this.adminAuditService.safeLog({
      actorUserId,
      action: BRAND_STAFF_AUDIT_ACTIONS.INVITE_REJECT,
      targetType: 'BrandStaffInvite',
      targetId: invite.id,
      metadata: {
        brandId: invite.brandId,
        invitedEmail: invite.email,
        role: invite.role,
      },
      previousState: { status: invite.status },
      newState: { status: updated.status, rejectedAt: updated.rejectedAt },
    });
    return this.mapInvite(updated);
  }

  async updateStaffRole(
    actorUserId: string,
    brandIdOrOwnerId: string,
    memberId: string,
    role: BrandMemberRole,
  ) {
    const brandId =
      await this.brandAccessService.resolveBrandIdFromBrandOrOwnerId(
        brandIdOrOwnerId,
      );
    await this.brandAccessService.assertCanManageStaff(actorUserId, brandId);
    this.assertAssignableStaffRole(role);

    const member = await this.getMemberOrThrow(brandId, memberId);
    if (member.role === BrandMemberRole.OWNER) {
      await this.brandAccessService.assertNotLastOwner(brandId, member.id);
    }

    const updated = await this.prisma.brandMember.update({
      where: { id: member.id },
      data: { role },
      include: { user: { select: STAFF_USER_SELECT } },
    });
    await this.adminAuditService.safeLog({
      actorUserId,
      action: BRAND_STAFF_AUDIT_ACTIONS.ROLE_UPDATE,
      targetType: 'BrandMember',
      targetId: member.id,
      metadata: {
        brandId,
        userId: member.userId,
      },
      previousState: { role: member.role },
      newState: { role: updated.role },
    });
    return this.mapMember(updated);
  }

  async updateStaffStatus(
    actorUserId: string,
    brandIdOrOwnerId: string,
    memberId: string,
    status: BrandMemberStatus,
  ) {
    const brandId =
      await this.brandAccessService.resolveBrandIdFromBrandOrOwnerId(
        brandIdOrOwnerId,
      );
    await this.brandAccessService.assertCanManageStaff(actorUserId, brandId);
    this.assertManageableStatus(status);

    const member = await this.getMemberOrThrow(brandId, memberId);
    if (
      member.role === BrandMemberRole.OWNER &&
      member.status === BrandMemberStatus.ACTIVE &&
      status !== BrandMemberStatus.ACTIVE
    ) {
      await this.brandAccessService.assertNotLastOwner(brandId, member.id);
    }

    const updated = await this.prisma.brandMember.update({
      where: { id: member.id },
      data: {
        status,
        ...(status === BrandMemberStatus.ACTIVE && !member.joinedAt
          ? { joinedAt: new Date() }
          : {}),
      },
      include: { user: { select: STAFF_USER_SELECT } },
    });
    await this.adminAuditService.safeLog({
      actorUserId,
      action: BRAND_STAFF_AUDIT_ACTIONS.STATUS_UPDATE,
      targetType: 'BrandMember',
      targetId: member.id,
      metadata: {
        brandId,
        userId: member.userId,
        role: member.role,
      },
      previousState: { status: member.status },
      newState: { status: updated.status },
    });
    return this.mapMember(updated);
  }

  async removeStaff(
    actorUserId: string,
    brandIdOrOwnerId: string,
    memberId: string,
  ) {
    return this.updateStaffStatus(
      actorUserId,
      brandIdOrOwnerId,
      memberId,
      BrandMemberStatus.REMOVED,
    );
  }

  async getStaffPermissions(
    actorUserId: string,
    brandIdOrOwnerId: string,
    memberId: string,
  ) {
    return this.brandPermissionService.getMemberPermissions(
      actorUserId,
      brandIdOrOwnerId,
      memberId,
    );
  }

  async updateStaffPermissions(
    actorUserId: string,
    brandIdOrOwnerId: string,
    memberId: string,
    permissions: string[],
  ) {
    const result = await this.brandPermissionService.setMemberPermissions(
      actorUserId,
      brandIdOrOwnerId,
      memberId,
      permissions,
    );
    const brandId =
      await this.brandAccessService.resolveBrandIdFromBrandOrOwnerId(
        brandIdOrOwnerId,
      );
    await this.adminAuditService.safeLog({
      actorUserId,
      action: BRAND_STAFF_AUDIT_ACTIONS.PERMISSION_UPDATE,
      targetType: 'BrandMember',
      targetId: memberId,
      metadata: {
        brandId,
        permissions: result.explicitPermissions,
      },
      newState: {
        explicitPermissions: result.explicitPermissions,
        effectivePermissions: result.effectivePermissions,
      },
    });
    return result;
  }
}
