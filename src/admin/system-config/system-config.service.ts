import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';

/** Default file-size limits in bytes */
export const DEFAULT_FILE_SIZE_LIMITS: Record<string, number> = {
  'upload.maxSize.profileImage': 2 * 1024 * 1024, // 2 MB
  'upload.maxSize.bannerImage': 2 * 1024 * 1024, // 2 MB
  'upload.maxSize.postImage': 2 * 1024 * 1024, // 2 MB
  'upload.maxSize.postVideo': 100 * 1024 * 1024, // 100 MB (videos are special)
  'upload.maxSize.reviewImage': 2 * 1024 * 1024, // 2 MB
  'upload.maxSize.reviewVideo': 40 * 1024 * 1024, // 40 MB
  'upload.maxSize.document': 2 * 1024 * 1024, // 2 MB
  'upload.maxSize.brandVerification': 2 * 1024 * 1024, // 2 MB
  'upload.maxSize.messageImage': 2 * 1024 * 1024, // 2 MB
  'upload.maxSize.messageDocument': 2 * 1024 * 1024, // 2 MB
  'upload.maxSize.productMedia': 2 * 1024 * 1024, // 2 MB
  'upload.maxSize.collectionBulk': 2 * 1024 * 1024, // 2 MB
};

export const DEFAULT_NUMBER_CONFIGS: Record<string, number> = {
  'finance.commission.defaultPercent': 10,
  'finance.commission.standardOrderPercent': 10,
  'finance.commission.customOrderPercent': 12,
  'finance.standardEscrow.firstReleasePercent': 50,
  'finance.standardEscrow.settlementHours': 48,
  'finance.standardEscrow.autoReleaseDays': 7,
  'reviews.editWindowHours': 24,
};

export const DEFAULT_BOOLEAN_CONFIGS: Record<string, boolean> = {
  'admin.dashboard.showDailySignupCount': true,
  'messaging.brandToBrand.enabled': false,
};

/** Descriptions for each config key */
const KEY_DESCRIPTIONS: Record<string, string> = {
  'upload.maxSize.profileImage': 'Max file size for profile images (bytes)',
  'upload.maxSize.bannerImage': 'Max file size for banner images (bytes)',
  'upload.maxSize.postImage': 'Max file size for post images (bytes)',
  'upload.maxSize.postVideo': 'Max file size for post videos (bytes)',
  'upload.maxSize.reviewImage': 'Max file size for review images (bytes)',
  'upload.maxSize.reviewVideo': 'Max file size for review videos (bytes)',
  'upload.maxSize.document': 'Max file size for documents (bytes)',
  'upload.maxSize.brandVerification':
    'Max file size for brand verification docs (bytes)',
  'upload.maxSize.messageImage': 'Max file size for message images (bytes)',
  'upload.maxSize.messageDocument':
    'Max file size for message documents (bytes)',
  'upload.maxSize.productMedia':
    'Max file size for product media uploads (bytes)',
  'upload.maxSize.collectionBulk':
    'Max file size for collection bulk uploads (bytes)',
  'finance.commission.defaultPercent':
    'Default platform commission percent for finance settlements',
  'finance.commission.standardOrderPercent':
    'Default commission percent applied to new standard checkout orders',
  'finance.commission.customOrderPercent':
    'Default commission percent applied to new custom orders',
  'finance.standardEscrow.firstReleasePercent':
    'Percent of a paid standard-order hold released when the brand confirms shipment',
  'finance.standardEscrow.settlementHours':
    'Hours to wait after buyer delivery confirmation before releasing the final standard-order tranche',
  'finance.standardEscrow.autoReleaseDays':
    'Days after a delivered standard order before the system auto-confirms delivery',
  'reviews.editWindowHours':
    'Hours after original review creation during which the buyer may edit the review',
  'admin.dashboard.showDailySignupCount':
    'Controls whether the admin dashboard shows the daily signup count card',
  'messaging.brandToBrand.enabled':
    'Controls whether brand accounts can initiate direct messages to other brands',
};

@Injectable()
export class SystemConfigService {
  private readonly logger = new Logger(SystemConfigService.name);

  /** In-memory cache — refreshed on write and periodically */
  private cache: Map<string, string> = new Map();
  private cacheLoadedAt = 0;
  private readonly CACHE_TTL_MS = 60_000; // 1 minute

  constructor(private readonly prisma: PrismaService) {}

  /* ------------------------------------------------------------------ */
  /*  Seed defaults (idempotent — call on app start)                     */
  /* ------------------------------------------------------------------ */

  async seedDefaults(): Promise<void> {
    await Promise.all(
      Object.entries(DEFAULT_FILE_SIZE_LIMITS).map(([key, value]) =>
        this.prisma.systemConfig.upsert({
          where: { key },
          create: {
            key,
            value: String(value),
            description: KEY_DESCRIPTIONS[key] ?? null,
          },
          update: {}, // don't overwrite admin customisations
        }),
      ),
    );
    await Promise.all(
      Object.entries(DEFAULT_BOOLEAN_CONFIGS).map(([key, value]) =>
        this.prisma.systemConfig.upsert({
          where: { key },
          create: {
            key,
            value: value ? 'true' : 'false',
            description: KEY_DESCRIPTIONS[key] ?? null,
          },
          update: {},
        }),
      ),
    );
    await Promise.all(
      Object.entries(DEFAULT_NUMBER_CONFIGS).map(([key, value]) =>
        this.prisma.systemConfig.upsert({
          where: { key },
          create: {
            key,
            value: String(value),
            description: KEY_DESCRIPTIONS[key] ?? null,
          },
          update: {},
        }),
      ),
    );
    this.logger.log('SystemConfig defaults seeded');
    await this.refreshCache();
  }

  /* ------------------------------------------------------------------ */
  /*  Cache helpers                                                      */
  /* ------------------------------------------------------------------ */

  private async refreshCache(): Promise<void> {
    const rows = await this.prisma.systemConfig.findMany();
    this.cache = new Map(rows.map((r) => [r.key, r.value]));
    this.cacheLoadedAt = Date.now();
  }

  private async ensureCache(): Promise<void> {
    if (Date.now() - this.cacheLoadedAt > this.CACHE_TTL_MS) {
      await this.refreshCache();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Public getters                                                     */
  /* ------------------------------------------------------------------ */

  /** Get a raw config value (string). Returns null if missing. */
  async getValue(key: string): Promise<string | null> {
    await this.ensureCache();
    return this.cache.get(key) ?? null;
  }

  /** Get a numeric config value. Falls back to the hardcoded default. */
  async getNumber(key: string): Promise<number> {
    const raw = await this.getValue(key);
    if (raw !== null) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (key in DEFAULT_NUMBER_CONFIGS) {
      return DEFAULT_NUMBER_CONFIGS[key];
    }
    return DEFAULT_FILE_SIZE_LIMITS[key] ?? 2 * 1024 * 1024;
  }

  async getBoolean(key: string): Promise<boolean> {
    const raw = await this.getValue(key);
    if (raw != null) {
      const normalized = raw.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return DEFAULT_BOOLEAN_CONFIGS[key] ?? false;
  }

  /** Get the max upload size (bytes) for a given FileType key. */
  async getMaxFileSize(configKey: string): Promise<number> {
    return this.getNumber(configKey);
  }

  /** List all config entries (admin UI). */
  async listAll() {
    return this.prisma.systemConfig.findMany({ orderBy: { key: 'asc' } });
  }

  /** Get all upload size limits as a flat map for the frontend. */
  async getUploadLimits(): Promise<Record<string, number>> {
    await this.ensureCache();
    const limits: Record<string, number> = {};
    for (const key of Object.keys(DEFAULT_FILE_SIZE_LIMITS)) {
      const raw = this.cache.get(key);
      const val = raw ? Number(raw) : DEFAULT_FILE_SIZE_LIMITS[key];
      limits[key] =
        Number.isFinite(val) && val > 0 ? val : DEFAULT_FILE_SIZE_LIMITS[key];
    }
    return limits;
  }

  /* ------------------------------------------------------------------ */
  /*  Admin write                                                        */
  /* ------------------------------------------------------------------ */

  async updateConfig(
    key: string,
    value: string,
    actorId: string,
    req: Request,
  ) {
    const existing = await this.prisma.systemConfig.findUnique({
      where: { key },
    });
    const previousValue = existing?.value ?? null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.systemConfig.upsert({
        where: { key },
        create: {
          key,
          value,
          description: KEY_DESCRIPTIONS[key] ?? null,
          updatedById: actorId,
        },
        update: {
          value,
          updatedById: actorId,
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_SYSTEM_SETTINGS_UPDATE,
          targetType: 'SystemConfig',
          targetId: key,
          previousState: { key, value: previousValue },
          newState: { key, value },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    // Invalidate cache immediately
    this.cache.set(key, value);

    return updated;
  }

  /** Bulk update multiple config keys at once. */
  async bulkUpdate(
    entries: { key: string; value: string }[],
    actorId: string,
    req: Request,
  ) {
    const results = [];
    for (const entry of entries) {
      results.push(
        await this.updateConfig(entry.key, entry.value, actorId, req),
      );
    }
    return results;
  }
}
