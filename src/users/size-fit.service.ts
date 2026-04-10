import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationType,
  Prisma,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { NotificationsService } from 'src/notifications/notifications.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RespondSizeFitShareDto, SizeFitShareDecision } from './dto/respond-size-fit-share.dto';
import { ShareSizeFitDto } from './dto/share-size-fit.dto';
import { UpdateSizeFitSettingsDto } from './dto/update-size-fit-settings.dto';
import { UpdateSizeFitDto } from './dto/update-size-fit.dto';

type PrismaTx = any;
type SizeFitVisibility = 'PUBLIC' | 'PRIVATE';
type SizeFitSharePolicy = 'OWNER_ONLY' | 'REQUIRE_PERMISSION' | 'ALLOW_ANYONE';
type SizeFitShareStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';

const SIZE_FIT_VISIBILITY = {
  PUBLIC: 'PUBLIC' as SizeFitVisibility,
  PRIVATE: 'PRIVATE' as SizeFitVisibility,
};

const SIZE_FIT_SHARE_POLICY = {
  OWNER_ONLY: 'OWNER_ONLY' as SizeFitSharePolicy,
  REQUIRE_PERMISSION: 'REQUIRE_PERMISSION' as SizeFitSharePolicy,
  ALLOW_ANYONE: 'ALLOW_ANYONE' as SizeFitSharePolicy,
};

const SIZE_FIT_SHARE_STATUS = {
  PENDING: 'PENDING' as SizeFitShareStatus,
  APPROVED: 'APPROVED' as SizeFitShareStatus,
  REJECTED: 'REJECTED' as SizeFitShareStatus,
  REVOKED: 'REVOKED' as SizeFitShareStatus,
};

type SafeMeasurements = Record<string, string | number | boolean | null>;
type BaselineMeasurementGender = 'MEN' | 'WOMEN';
type BaselineMeasurementSlot =
  | 'SHOULDER'
  | 'CHEST'
  | 'WAIST'
  | 'HIP'
  | 'INSEAM'
  | 'SLEEVE_LENGTH';

const BASELINE_MEASUREMENT_SLOTS: BaselineMeasurementSlot[] = [
  'SHOULDER',
  'CHEST',
  'WAIST',
  'HIP',
  'INSEAM',
  'SLEEVE_LENGTH',
];

const BASELINE_SLOT_KEY_CANDIDATES: Record<
  BaselineMeasurementSlot,
  { men: string[]; women: string[]; neutral: string[] }
> = {
  SHOULDER: {
    men: ['MEN_SHOULDER'],
    women: ['WOMEN_SHOULDER_WIDTH'],
    neutral: ['UNISEX_SHOULDER', 'SHOULDER', 'SHOULDER_WIDTH'],
  },
  CHEST: {
    men: ['MEN_CHEST'],
    women: ['WOMEN_CHEST_FULL_BUST'],
    neutral: ['UNISEX_CHEST', 'CHEST', 'CHEST_FULL_BUST'],
  },
  WAIST: {
    men: ['MEN_WAIST'],
    women: ['WOMEN_WAIST'],
    neutral: ['UNISEX_WAIST', 'WAIST'],
  },
  HIP: {
    men: ['MEN_HIP'],
    women: ['WOMEN_HIP'],
    neutral: ['UNISEX_HIP', 'HIP'],
  },
  INSEAM: {
    men: ['MEN_INSEAM'],
    women: ['WOMEN_INSEAM'],
    neutral: ['UNISEX_INSEAM', 'INSEAM'],
  },
  SLEEVE_LENGTH: {
    men: ['MEN_SLEEVE_LENGTH'],
    women: ['WOMEN_SLEEVE_LENGTH_LONG'],
    neutral: ['UNISEX_SLEEVE_LENGTH', 'SLEEVE_LENGTH', 'SLEEVE_LENGTH_LONG'],
  },
};

const REMINDER_TARGET = {
  type: 'USER',
} as const;

const NT_SIZE_FIT_UPDATE_REMINDER = 'SIZE_FIT_UPDATE_REMINDER' as NotificationType;
const NT_SIZE_FIT_SHARED = 'SIZE_FIT_SHARED' as NotificationType;
const NT_SIZE_FIT_SHARE_REQUEST = 'SIZE_FIT_SHARE_REQUEST' as NotificationType;
const NT_SIZE_FIT_SHARE_APPROVED = 'SIZE_FIT_SHARE_APPROVED' as NotificationType;
const NT_SIZE_FIT_SHARE_REJECTED = 'SIZE_FIT_SHARE_REJECTED' as NotificationType;
const NT_SIZE_FIT_RESHARED = 'SIZE_FIT_RESHARED' as NotificationType;

@Injectable()
export class SizeFitService {
  private readonly logger = new Logger(SizeFitService.name);

  private normalizeMeasurementDisplayLabel(rawLabel: string): string {
    return String(rawLabel ?? '')
      .trim()
      .replace(/^BRAND[_\-\s]+[^_\-\s]+[_\-\s]+/i, '')
      .replace(/^(MEN|WOMEN|WOMAN|UNISEX)[_\-\s]+/i, '')
      .replace(/[_\-\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private toIso(date: Date | null | undefined): string | null {
    return date ? date.toISOString() : null;
  }

  private daysToMs(days: number): number {
    return days * 24 * 60 * 60 * 1000;
  }

  private normalizeReminderDays(days?: number | null): number {
    if (!days || !Number.isFinite(days)) return 14;
    return Math.max(14, Math.min(90, Math.round(days)));
  }

  private sanitizeMeasurements(raw: unknown): SafeMeasurements {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }

    const input = raw as Record<string, unknown>;
    const output: SafeMeasurements = {};

    for (const [key, value] of Object.entries(input)) {
      if (!key || key.length > 64) continue;

      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
      ) {
        output[key] = value as string | number | boolean | null;
      }
    }

    return output;
  }

  private computeChangedKeys(
    prevRaw: Prisma.JsonValue | null | undefined,
    next: SafeMeasurements,
  ): string[] {
    const prev =
      prevRaw && typeof prevRaw === 'object' && !Array.isArray(prevRaw)
        ? (prevRaw as Record<string, unknown>)
        : {};

    const keySet = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
    const changed = Array.from(keySet).filter((key) => {
      const a = prev[key];
      const b = next[key];
      return JSON.stringify(a) !== JSON.stringify(b);
    });
    changed.sort();
    return changed;
  }

  private inferMeasurementGender(
    measurements: SafeMeasurements,
    preferredKeys: string[] = [],
  ): BaselineMeasurementGender | null {
    const keys = [...preferredKeys, ...Object.keys(measurements)];
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      if (key.startsWith('MEN_')) return 'MEN';
      if (key.startsWith('WOMEN_')) return 'WOMEN';
    }
    return null;
  }

  private hasUsableMeasurementValue(value: unknown): boolean {
    if (typeof value === 'number') {
      return Number.isFinite(value) && value > 0;
    }
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) && parsed > 0;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = (value as Record<string, unknown>).value;
      if (typeof nested === 'number') {
        return Number.isFinite(nested) && nested > 0;
      }
    }
    return false;
  }

  private normalizeBaselineGender(gender: BaselineMeasurementGender | null): BaselineMeasurementGender {
    return gender ?? 'WOMEN';
  }

  private buildBaselineSlotCandidates(gender: BaselineMeasurementGender | null) {
    const preferredGender = this.normalizeBaselineGender(gender);

    return BASELINE_MEASUREMENT_SLOTS.map((slot) => {
      const config = BASELINE_SLOT_KEY_CANDIDATES[slot];
      const preferred = preferredGender === 'MEN' ? config.men : config.women;
      const fallback = preferredGender === 'MEN' ? config.women : config.men;
      const orderedCandidates = [...preferred, ...config.neutral, ...fallback];

      return {
        slot,
        orderedCandidates,
      };
    });
  }

  private formatMeasurementLabelFromKey(key: string): string {
    return this.normalizeMeasurementDisplayLabel(key)
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  private async resolveBaselineMeasurementPoints(gender: BaselineMeasurementGender | null) {
    const slots = this.buildBaselineSlotCandidates(gender);
    const orderedKeys = Array.from(new Set(slots.flatMap((slot) => slot.orderedCandidates)));

    const points = await (this.prisma as any).measurementPoint.findMany({
      where: {
        key: { in: orderedKeys },
        source: 'SYSTEM',
        status: 'APPROVED_GLOBAL',
        isActive: true,
      },
      select: {
        key: true,
        label: true,
        description: true,
        category: true,
        minValueCm: true,
        maxValueCm: true,
      },
    });

    const byKey = new Map<string, any>(points.map((point: any) => [point.key, point]));

    // Always return baseline slots so users can continue updating fittings incrementally,
    // even if measurement-point rows are temporarily missing in a given environment.
    return slots.map(({ orderedCandidates }) => {
      const point = orderedCandidates
        .map((key) => byKey.get(key) as any | undefined)
        .find((candidate) => Boolean(candidate));
      const fallbackKey = orderedCandidates[0];

      if (!point) {
        return {
          key: fallbackKey,
          label: this.formatMeasurementLabelFromKey(fallbackKey),
          description: null,
          category: 'GENERAL',
          minValueCm: null,
          maxValueCm: null,
          required: true,
        };
      }

      return {
        key: point.key,
        label: this.normalizeMeasurementDisplayLabel(point.label),
        description: point.description,
        category: point.category,
        minValueCm: point.minValueCm == null ? null : Number(point.minValueCm),
        maxValueCm: point.maxValueCm == null ? null : Number(point.maxValueCm),
        required: true,
      };
    });
  }

  private async ensureProfile(userId: string, db: PrismaTx = this.prisma) {
    const existing = await (db as any).userSizeFitProfile.findUnique({
      where: { userId },
    });
    if (existing) return existing;

    const now = new Date();
    return (db as any).userSizeFitProfile.create({
      data: {
        id: uuidv4(),
        userId,
        visibility: SIZE_FIT_VISIBILITY.PRIVATE,
        sharePolicy: SIZE_FIT_SHARE_POLICY.REQUIRE_PERMISSION,
        notifyOnShare: true,
        requireUpdateEveryDays: 14,
        version: 0,
        preferredLengthUnit: 'CM',
        preferredWeightUnit: 'KG',
        fitPreference: 'REGULAR',
        label: 'My Measurements',
        measurements: {},
        lastUpdatedAt: null,
        nextReminderAt: now,
      },
    });
  }

  private async hasApprovedShare(
    profileId: string,
    viewerId: string | undefined,
    db: PrismaTx = this.prisma,
  ): Promise<boolean> {
    if (!viewerId) return false;
    const share = await (db as any).userSizeFitShare.findUnique({
      where: { profileId_viewerId: { profileId, viewerId } },
      select: { id: true, status: true },
    });
    return share?.status === SIZE_FIT_SHARE_STATUS.APPROVED;
  }

  async getMySizeFit(userId: string) {
    const profile = await this.ensureProfile(userId);
    const now = new Date();
    const measurements =
      profile.measurements &&
      typeof profile.measurements === 'object' &&
      !Array.isArray(profile.measurements)
        ? (profile.measurements as Record<string, unknown>)
        : {};
    const inferredGender = this.inferMeasurementGender(
      this.sanitizeMeasurements(profile.measurements),
    );
    const baselineMeasurementPoints = await this.resolveBaselineMeasurementPoints(inferredGender);
    const baselineRequiredKeys = baselineMeasurementPoints.map((point: any) => point.key);
    const missingBaselineKeys = baselineRequiredKeys.filter(
      (key) => !this.hasUsableMeasurementValue(measurements[key]),
    );

    const [latestRevision, incomingPending, outgoingPending, sharedWithMe] =
      await Promise.all([
        (this.prisma as any).userSizeFitRevision.findFirst({
          where: { profileId: profile.id },
          orderBy: { version: 'desc' },
          select: { version: true, changedKeys: true, createdAt: true },
        }),
        (this.prisma as any).userSizeFitShare.count({
          where: {
            ownerId: userId,
            status: SIZE_FIT_SHARE_STATUS.PENDING,
          },
        }),
        (this.prisma as any).userSizeFitShare.count({
          where: {
            requestedById: userId,
            status: SIZE_FIT_SHARE_STATUS.PENDING,
          },
        }),
        (this.prisma as any).userSizeFitShare.count({
          where: {
            viewerId: userId,
            status: SIZE_FIT_SHARE_STATUS.APPROVED,
          },
        }),
      ]);

    const due =
      !profile.lastUpdatedAt ||
      (profile.nextReminderAt ? profile.nextReminderAt.getTime() <= now.getTime() : true);

    return {
      id: profile.id,
      userId: profile.userId,
      visibility: profile.visibility,
      sharePolicy: profile.sharePolicy,
      notifyOnShare: profile.notifyOnShare,
      requireUpdateEveryDays: profile.requireUpdateEveryDays,
      version: profile.version,
      preferredLengthUnit: profile.preferredLengthUnit,
      preferredWeightUnit: profile.preferredWeightUnit,
      fitPreference: profile.fitPreference,
      label: profile.label,
      measurements,
      measurementGender: this.normalizeBaselineGender(inferredGender),
      baselineMeasurementPoints,
      baselineRequiredKeys,
      missingBaselineKeys,
      notes: profile.notes ?? '',
      lastUpdatedAt: this.toIso(profile.lastUpdatedAt),
      nextReminderAt: this.toIso(profile.nextReminderAt),
      isUpdateDue: due,
      latestRevision: latestRevision
        ? {
            version: latestRevision.version,
            changedKeys: latestRevision.changedKeys,
            createdAt: this.toIso(latestRevision.createdAt),
          }
        : null,
      counters: {
        incomingPendingShareRequests: incomingPending,
        outgoingPendingShareRequests: outgoingPending,
        sharedWithMeCount: sharedWithMe,
      },
    };
  }

  async getSizeFitForViewer(ownerId: string, viewerId?: string) {
    if (viewerId && ownerId === viewerId) {
      return this.getMySizeFit(ownerId);
    }

    const profile = await (this.prisma as any).userSizeFitProfile.findUnique({
      where: { userId: ownerId },
      select: {
        id: true,
        userId: true,
        visibility: true,
        sharePolicy: true,
        notifyOnShare: true,
        requireUpdateEveryDays: true,
        version: true,
        preferredLengthUnit: true,
        preferredWeightUnit: true,
        fitPreference: true,
        label: true,
        measurements: true,
        notes: true,
        lastUpdatedAt: true,
        nextReminderAt: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('Size fitting profile not found');
    }

    const hasShare = await this.hasApprovedShare(profile.id, viewerId);
    const isPublic = profile.visibility === SIZE_FIT_VISIBILITY.PUBLIC;
    const canView = isPublic || hasShare;
    if (!canView) {
      throw new ForbiddenException(
        'This size fitting profile is private. Request access first.',
      );
    }

    return {
      id: profile.id,
      userId: profile.userId,
      visibility: profile.visibility,
      sharePolicy: profile.sharePolicy,
      version: profile.version,
      preferredLengthUnit: profile.preferredLengthUnit,
      preferredWeightUnit: profile.preferredWeightUnit,
      fitPreference: profile.fitPreference,
      label: profile.label,
      measurements:
        profile.measurements &&
        typeof profile.measurements === 'object' &&
        !Array.isArray(profile.measurements)
          ? profile.measurements
          : {},
      notes: profile.notes ?? '',
      lastUpdatedAt: this.toIso(profile.lastUpdatedAt),
      nextReminderAt: this.toIso(profile.nextReminderAt),
      access: {
        byPublicVisibility: isPublic,
        byShare: hasShare,
      },
    };
  }

  async updateMySizeFit(userId: string, dto: UpdateSizeFitDto) {
    return this.prisma.$transaction(async (tx) => {
      const profile = await this.ensureProfile(userId, tx);

      const currentMeasurements = this.sanitizeMeasurements(profile.measurements);
      const nextMeasurements = dto.measurements
        ? {
            ...currentMeasurements,
            ...this.sanitizeMeasurements(dto.measurements),
          }
        : currentMeasurements;
      const changedKeys = this.computeChangedKeys(profile.measurements, nextMeasurements);

      const reminderDays = this.normalizeReminderDays(
        dto.requireUpdateEveryDays ?? profile.requireUpdateEveryDays,
      );
      if (typeof dto.version === 'number' && dto.version !== profile.version) {
        throw new ConflictException('Size fit profile has been updated. Refresh and retry.');
      }
      const now = new Date();
      const nextReminderAt = new Date(now.getTime() + this.daysToMs(reminderDays));

      const updated = await (tx as any).userSizeFitProfile.update({
        where: { id: profile.id },
        data: {
          measurements: nextMeasurements as unknown as Prisma.InputJsonValue,
          notes: dto.notes ?? profile.notes,
          requireUpdateEveryDays: reminderDays,
          label: dto.label ?? profile.label,
          preferredLengthUnit:
            (dto.preferredLengthUnit as unknown as string | undefined) ??
            profile.preferredLengthUnit,
          preferredWeightUnit:
            (dto.preferredWeightUnit as unknown as string | undefined) ??
            profile.preferredWeightUnit,
          fitPreference:
            (dto.fitPreference as unknown as string | undefined) ??
            profile.fitPreference,
          version: profile.version + 1,
          lastUpdatedAt: now,
          nextReminderAt,
        },
      });

      const latestRevision = await (tx as any).userSizeFitRevision.findFirst({
        where: { profileId: profile.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = (latestRevision?.version ?? 0) + 1;

      await (tx as any).userSizeFitRevision.create({
        data: {
          id: uuidv4(),
          profileId: profile.id,
          version: nextVersion,
          measurements: nextMeasurements as unknown as Prisma.InputJsonValue,
          changedKeys,
          createdById: userId,
        },
      });

      const inferredGender = this.inferMeasurementGender(nextMeasurements);
      const baselineMeasurementPoints = await this.resolveBaselineMeasurementPoints(inferredGender);
      const baselineRequiredKeys = baselineMeasurementPoints.map((point: any) => point.key);
      const missingBaselineKeys = baselineRequiredKeys.filter(
        (key) => !this.hasUsableMeasurementValue(nextMeasurements[key]),
      );

      return {
        id: updated.id,
        userId: updated.userId,
        visibility: updated.visibility,
        sharePolicy: updated.sharePolicy,
        notifyOnShare: updated.notifyOnShare,
        requireUpdateEveryDays: updated.requireUpdateEveryDays,
        version: updated.version,
        preferredLengthUnit: updated.preferredLengthUnit,
        preferredWeightUnit: updated.preferredWeightUnit,
        fitPreference: updated.fitPreference,
        label: updated.label,
        measurements: nextMeasurements,
        measurementGender: this.normalizeBaselineGender(inferredGender),
        baselineMeasurementPoints,
        baselineRequiredKeys,
        missingBaselineKeys,
        notes: updated.notes ?? '',
        lastUpdatedAt: this.toIso(updated.lastUpdatedAt),
        nextReminderAt: this.toIso(updated.nextReminderAt),
        latestRevision: {
          version: nextVersion,
          changedKeys,
          createdAt: this.toIso(now),
        },
      };
    });
  }

  async updateMySizeFitSettings(userId: string, dto: UpdateSizeFitSettingsDto) {
    const profile = await this.ensureProfile(userId);
    const reminderDays = this.normalizeReminderDays(
      dto.requireUpdateEveryDays ?? profile.requireUpdateEveryDays,
    );

    const updated = await (this.prisma as any).userSizeFitProfile.update({
      where: { id: profile.id },
      data: {
        visibility: dto.visibility ?? profile.visibility,
        sharePolicy: dto.sharePolicy ?? profile.sharePolicy,
        notifyOnShare: dto.notifyOnShare ?? profile.notifyOnShare,
        requireUpdateEveryDays: reminderDays,
      },
    });

    return {
      id: updated.id,
      userId: updated.userId,
      visibility: updated.visibility,
      sharePolicy: updated.sharePolicy,
      notifyOnShare: updated.notifyOnShare,
      requireUpdateEveryDays: updated.requireUpdateEveryDays,
      version: updated.version,
      preferredLengthUnit: updated.preferredLengthUnit,
      preferredWeightUnit: updated.preferredWeightUnit,
      fitPreference: updated.fitPreference,
      label: updated.label,
      lastUpdatedAt: this.toIso(updated.lastUpdatedAt),
      nextReminderAt: this.toIso(updated.nextReminderAt),
    };
  }

  async listMySizeFitShareRequests(userId: string) {
    const [incoming, outgoing, sharesGiven, sharesReceived] = await Promise.all([
      (this.prisma as any).userSizeFitShare.findMany({
        where: { ownerId: userId, status: SIZE_FIT_SHARE_STATUS.PENDING },
        include: {
          viewer: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              profileImage: true,
            },
          },
          requestedBy: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              profileImage: true,
            },
          },
          profile: { select: { userId: true, visibility: true, sharePolicy: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      (this.prisma as any).userSizeFitShare.findMany({
        where: { requestedById: userId, status: SIZE_FIT_SHARE_STATUS.PENDING },
        include: {
          owner: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              profileImage: true,
            },
          },
          viewer: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              profileImage: true,
            },
          },
          profile: { select: { userId: true, visibility: true, sharePolicy: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      (this.prisma as any).userSizeFitShare.findMany({
        where: { ownerId: userId, status: SIZE_FIT_SHARE_STATUS.APPROVED },
        include: {
          viewer: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              profileImage: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
      (this.prisma as any).userSizeFitShare.findMany({
        where: { viewerId: userId, status: SIZE_FIT_SHARE_STATUS.APPROVED },
        include: {
          owner: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              profileImage: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
    ]);

    return {
      incoming,
      outgoing,
      sharesGiven,
      sharesReceived,
    };
  }

  async shareSizeFit(actorId: string, dto: ShareSizeFitDto) {
    const ownerId = dto.profileUserId ?? actorId;
    const targetUserId = await this.resolveShareTargetUserId(dto);

    if (ownerId === targetUserId) {
      throw new BadRequestException('Cannot share size fit with the profile owner');
    }

    if (actorId === targetUserId) {
      throw new BadRequestException('Cannot target yourself for this share action');
    }

    const owner = await this.prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } });
    if (!owner) throw new NotFoundException('Size fit owner not found');

    const profile =
      ownerId === actorId
        ? await this.ensureProfile(ownerId)
        : await (this.prisma as any).userSizeFitProfile.findUnique({ where: { userId: ownerId } });

    if (!profile) {
      throw new NotFoundException('Size fitting profile not found');
    }

    const actorIsOwner = actorId === ownerId;
    const actorCanView =
      actorIsOwner ||
      profile.visibility === SIZE_FIT_VISIBILITY.PUBLIC ||
      (await this.hasApprovedShare(profile.id, actorId));
    if (!actorCanView) {
      throw new ForbiddenException('You do not have access to this size fitting profile');
    }

    const existing = await (this.prisma as any).userSizeFitShare.findUnique({
      where: { profileId_viewerId: { profileId: profile.id, viewerId: targetUserId } },
    });

    if (actorIsOwner) {
      const canReshare = Boolean(dto.canReshare);
      const share = existing
        ? await (this.prisma as any).userSizeFitShare.update({
            where: { id: existing.id },
            data: {
              status: SIZE_FIT_SHARE_STATUS.APPROVED,
              requestedById: actorId,
              canReshare,
              note: dto.note ?? existing.note,
              respondedAt: new Date(),
            },
          })
        : await (this.prisma as any).userSizeFitShare.create({
            data: {
              id: uuidv4(),
              profileId: profile.id,
              ownerId,
              viewerId: targetUserId,
              requestedById: actorId,
              status: SIZE_FIT_SHARE_STATUS.APPROVED,
              canReshare,
              note: dto.note,
              respondedAt: new Date(),
            },
          });

      await this.notifications.create(targetUserId, NT_SIZE_FIT_SHARED, {
        actorId: ownerId,
        target: { ...REMINDER_TARGET, id: ownerId },
        payload: {
          targetUrl: `/profile/${ownerId}`,
          message: 'A size fitting profile was shared with you',
          ownerId,
        },
        dedupeMs: 60_000,
      });

      return { status: share.status, shareId: share.id, requiresApproval: false };
    }

    if (profile.sharePolicy === SIZE_FIT_SHARE_POLICY.OWNER_ONLY) {
      throw new ForbiddenException('This size fitting profile does not allow re-sharing');
    }

    if (profile.sharePolicy === SIZE_FIT_SHARE_POLICY.REQUIRE_PERMISSION) {
      const pending = existing
        ? await (this.prisma as any).userSizeFitShare.update({
            where: { id: existing.id },
            data: {
              status: SIZE_FIT_SHARE_STATUS.PENDING,
              requestedById: actorId,
              note: dto.note ?? existing.note,
              respondedAt: null,
            },
          })
        : await (this.prisma as any).userSizeFitShare.create({
            data: {
              id: uuidv4(),
              profileId: profile.id,
              ownerId,
              viewerId: targetUserId,
              requestedById: actorId,
              status: SIZE_FIT_SHARE_STATUS.PENDING,
              canReshare: false,
              note: dto.note,
            },
          });

      await this.notifications.create(ownerId, NT_SIZE_FIT_SHARE_REQUEST, {
        actorId,
        target: { ...REMINDER_TARGET, id: ownerId },
        payload: {
          targetUrl: `/profile/${ownerId}`,
          message: 'A user requested permission to share your private fitting profile',
          requestedViewerId: targetUserId,
        },
        dedupeMs: 60_000,
      });

      return { status: pending.status, shareId: pending.id, requiresApproval: true };
    }

    const shared = existing
      ? await (this.prisma as any).userSizeFitShare.update({
          where: { id: existing.id },
          data: {
            status: SIZE_FIT_SHARE_STATUS.APPROVED,
            requestedById: actorId,
            canReshare: false,
            note: dto.note ?? existing.note,
            respondedAt: new Date(),
          },
        })
      : await (this.prisma as any).userSizeFitShare.create({
          data: {
            id: uuidv4(),
            profileId: profile.id,
            ownerId,
            viewerId: targetUserId,
            requestedById: actorId,
            status: SIZE_FIT_SHARE_STATUS.APPROVED,
            canReshare: false,
            note: dto.note,
            respondedAt: new Date(),
          },
        });

    await this.notifications.create(targetUserId, NT_SIZE_FIT_SHARED, {
      actorId,
      target: { ...REMINDER_TARGET, id: ownerId },
      payload: {
        targetUrl: `/profile/${ownerId}`,
        message: 'A size fitting profile was shared with you',
        ownerId,
      },
      dedupeMs: 60_000,
    });

    if (profile.notifyOnShare) {
      await this.notifications.create(ownerId, NT_SIZE_FIT_RESHARED, {
        actorId,
        target: { ...REMINDER_TARGET, id: ownerId },
        payload: {
          targetUrl: `/profile/${ownerId}`,
          message: 'Your fitting profile was shared again',
          targetUserId,
        },
        dedupeMs: 60_000,
      });
    }

    return { status: shared.status, shareId: shared.id, requiresApproval: false };
  }

  private async resolveShareTargetUserId(dto: ShareSizeFitDto): Promise<string> {
    if (dto.targetUserId) {
      const target = await this.prisma.user.findUnique({ where: { id: dto.targetUserId }, select: { id: true } });
      if (!target) {
        throw new NotFoundException('Target user not found');
      }
      return target.id;
    }

    const targetIdentifier = dto.targetUserIdentifier?.trim();
    if (!targetIdentifier) {
      throw new BadRequestException('Target user identifier is required');
    }

    const normalizedHandle = targetIdentifier.startsWith('@') ? targetIdentifier.slice(1) : targetIdentifier;
    const target = await this.prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: normalizedHandle, mode: 'insensitive' } },
          { email: { equals: targetIdentifier, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
    });

    if (!target) {
      throw new NotFoundException('Target user not found');
    }

    return target.id;
  }

  async respondToShareRequest(ownerId: string, shareId: string, dto: RespondSizeFitShareDto) {
    const share = await (this.prisma as any).userSizeFitShare.findUnique({
      where: { id: shareId },
      include: {
        profile: { select: { userId: true } },
      },
    });

    if (!share) {
      throw new NotFoundException('Share request not found');
    }
    if (share.ownerId !== ownerId) {
      throw new ForbiddenException('Not allowed to act on this share request');
    }

    let status: SizeFitShareStatus;
    if (dto.decision === SizeFitShareDecision.APPROVE) {
      status = SIZE_FIT_SHARE_STATUS.APPROVED;
    } else if (dto.decision === SizeFitShareDecision.REVOKE) {
      status = SIZE_FIT_SHARE_STATUS.REVOKED;
    } else {
      status = SIZE_FIT_SHARE_STATUS.REJECTED;
    }

    const updated = await (this.prisma as any).userSizeFitShare.update({
      where: { id: share.id },
      data: {
        status,
        note: dto.note ?? share.note,
        respondedAt: new Date(),
      },
    });

    if (status === SIZE_FIT_SHARE_STATUS.APPROVED) {
      await this.notifications.create(updated.viewerId, NT_SIZE_FIT_SHARE_APPROVED, {
        actorId: ownerId,
        target: { ...REMINDER_TARGET, id: ownerId },
        payload: {
          targetUrl: `/profile/${ownerId}`,
          message: 'Your fitting share request was approved',
        },
        dedupeMs: 60_000,
      });
    } else {
      await this.notifications.create(updated.viewerId, NT_SIZE_FIT_SHARE_REJECTED, {
        actorId: ownerId,
        target: { ...REMINDER_TARGET, id: ownerId },
        payload: {
          targetUrl: `/profile/${ownerId}`,
          message:
            status === SIZE_FIT_SHARE_STATUS.REVOKED
              ? 'Your fitting access was revoked'
              : 'Your fitting share request was rejected',
        },
        dedupeMs: 60_000,
      });
    }

    return {
      id: updated.id,
      status: updated.status,
      respondedAt: this.toIso(updated.respondedAt),
      note: updated.note ?? '',
    };
  }

  async sendDueUpdateReminders(batchSize = 250): Promise<number> {
    const now = new Date();
    const dueProfiles = await (this.prisma as any).userSizeFitProfile.findMany({
      where: {
        OR: [{ nextReminderAt: { lte: now } }, { nextReminderAt: null }],
      },
      orderBy: { updatedAt: 'asc' },
      take: batchSize,
      select: {
        id: true,
        userId: true,
        requireUpdateEveryDays: true,
      },
    });

    if (dueProfiles.length === 0) {
      return 0;
    }

    let sent = 0;
    for (const profile of dueProfiles) {
      try {
        await this.notifications.create(
          profile.userId,
          NT_SIZE_FIT_UPDATE_REMINDER,
          {
            target: { ...REMINDER_TARGET, id: profile.userId },
            payload: {
              targetUrl: '/profile',
              message:
                'Please update your custom size/fits profile. We recommend refreshing it every 2 weeks.',
            },
            dedupeMs: this.daysToMs(6),
          },
        );

        const nextDays = this.normalizeReminderDays(profile.requireUpdateEveryDays);
        await (this.prisma as any).userSizeFitProfile.update({
          where: { id: profile.id },
          data: {
            nextReminderAt: new Date(now.getTime() + this.daysToMs(nextDays)),
          },
        });
        sent += 1;
      } catch (error) {
        this.logger.warn(
          `Failed to send size fit reminder for profile ${profile.id}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    return sent;
  }
}
