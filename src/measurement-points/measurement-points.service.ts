import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createClient, type RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateFreeformPointDto } from './dto/create-freeform-point.dto';
import { QueryMeasurementPointsDto } from './dto/query-measurement-points.dto';

type MeasurementPointRow = {
  id: string;
  key: string;
  label: string;
  description: string | null;
  category: 'UPPER_BODY' | 'ARMS' | 'LOWER_BODY' | 'LENGTH' | 'GENERAL' | 'ACCESSORIES';
  gender: 'MEN' | 'WOMEN' | 'UNISEX' | null;
  source: 'SYSTEM' | 'BRAND_FREEFORM';
  status: 'BRAND_ONLY' | 'APPROVED_GLOBAL' | 'REJECTED';
  brandId: string | null;
  minValueCm: Prisma.Decimal | null;
  maxValueCm: Prisma.Decimal | null;
  minValueChildCm: Prisma.Decimal | null;
  maxValueChildCm: Prisma.Decimal | null;
  sortOrder: number;
  isActive: boolean;
};

@Injectable()
export class MeasurementPointsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MeasurementPointsService.name);
  private redis: RedisClientType | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    const redisUrl = String(process.env.REDIS_URL || '').trim();
    if (!redisUrl) return;

    try {
      this.redis = createClient({ url: redisUrl });
      this.redis.on('error', (error) => {
        this.logger.warn(`Measurement points Redis error: ${error?.message || error}`);
      });
      await this.redis.connect();
    } catch (error) {
      this.logger.warn(
        `Measurement points Redis unavailable, continuing without Redis cache: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      this.redis = null;
    }
  }

  async onModuleDestroy() {
    if (!this.redis) return;
    try {
      await this.redis.quit();
    } catch {
      this.redis = null;
    }
  }

  private toCacheKey(filter?: QueryMeasurementPointsDto, brandId?: string | null) {
    const gender = filter?.gender ?? 'ALL';
    const category = filter?.category ?? 'ALL';
    const scope = brandId ? `BRAND:${brandId}` : 'SYSTEM';
    return `mp:registry:${scope}:${gender}:${category}`;
  }

  private buildFilterWhere(filter?: QueryMeasurementPointsDto): any {
    return {
      source: 'SYSTEM',
      status: 'APPROVED_GLOBAL',
      isActive: true,
      ...(filter?.gender
        ? {
            OR: [{ gender: filter.gender }, { gender: 'UNISEX' }, { gender: null }],
          }
        : {}),
      ...(filter?.category ? { category: filter.category } : {}),
    };
  }

  private mapPoint(point: MeasurementPointRow) {
    const toNumber = (value: Prisma.Decimal | null) => (value == null ? null : Number(value));

    return {
      id: point.id,
      key: point.key,
      label: point.label,
      description: point.description,
      category: point.category,
      gender: point.gender,
      source: point.source,
      status: point.status,
      brandId: point.brandId,
      minValueCm: toNumber(point.minValueCm),
      maxValueCm: toNumber(point.maxValueCm),
      minValueChildCm: toNumber(point.minValueChildCm),
      maxValueChildCm: toNumber(point.maxValueChildCm),
      sortOrder: point.sortOrder,
      isActive: point.isActive,
    };
  }

  async getAll(
    filter?: QueryMeasurementPointsDto,
    authUserId?: string,
    authUserType?: string,
  ) {
    let brandId: string | null = null;
    if (authUserId && authUserType === 'BRAND') {
      try {
        brandId = await this.resolveBrandForOwner(authUserId);
      } catch {
        brandId = null;
      }
    }

    const cacheKey = this.toCacheKey(filter, brandId);

    if (this.redis) {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }

    const systemWhere = this.buildFilterWhere(filter);
    const genderScope = filter?.gender
      ? {
          OR: [{ gender: filter.gender }, { gender: 'UNISEX' }, { gender: null }],
        }
      : {};
    const categoryScope = filter?.category ? { category: filter.category } : {};

    const points = await (this.prisma as any).measurementPoint.findMany({
      where: brandId
        ? {
            OR: [
              systemWhere,
              {
                source: 'BRAND_FREEFORM',
                status: 'BRAND_ONLY',
                brandId,
                isActive: true,
                ...genderScope,
                ...categoryScope,
              },
            ],
          }
        : systemWhere,
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
    });

    const mapped = points.map((point: MeasurementPointRow) => this.mapPoint(point));

    if (this.redis) {
      await this.redis.set(cacheKey, JSON.stringify(mapped), { EX: 60 * 60 * 24 });
    }

    return mapped;
  }

  private async resolveBrandForOwner(ownerUserId: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId: ownerUserId },
      select: { id: true },
    });

    if (!brand) {
      throw new NotFoundException('Brand profile not found');
    }

    return brand.id;
  }

  async getForBrand(authUserId: string, brandId: string) {
    const ownerBrandId = await this.resolveBrandForOwner(authUserId);
    if (ownerBrandId !== brandId) {
      throw new ForbiddenException('You can only access measurement points for your own brand');
    }

    const points = await (this.prisma as any).measurementPoint.findMany({
      where: {
        isActive: true,
        OR: [
          {
            source: 'SYSTEM',
            status: 'APPROVED_GLOBAL',
          },
          {
            source: 'BRAND_FREEFORM',
            brandId,
          },
        ],
      },
      orderBy: [{ source: 'asc' }, { category: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
    });

    return points.map((point: MeasurementPointRow) => this.mapPoint(point));
  }

  private normalizeLabel(label: string): string {
    return label.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private buildKeyFromLabel(label: string, brandId: string): string {
    const cleaned = label
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 40);

    return `BRAND_${brandId.slice(0, 8)}_${cleaned}`;
  }

  private async findFuzzyMatches(label: string) {
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ id: string; key: string; label: string; similarity: number }>
      >`
        SELECT id::text, key, label, similarity(label, ${label}) AS similarity
        FROM "MeasurementPoint"
        WHERE similarity(label, ${label}) >= 0.6
        ORDER BY similarity DESC
        LIMIT 5
      `;

      return rows;
    } catch (error) {
      this.logger.warn(
        `Fuzzy matching unavailable (pg_trgm likely missing): ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return [];
    }
  }

  async submitFreeform(authUserId: string, dto: CreateFreeformPointDto) {
    const brandId = await this.resolveBrandForOwner(authUserId);
    const normalizedLabel = this.normalizeLabel(dto.label);

    const freeformCount = await (this.prisma as any).measurementPoint.count({
      where: {
        brandId,
        source: 'BRAND_FREEFORM',
      },
    });

    if (freeformCount >= 10) {
      throw new HttpException(
        'Freeform measurement point limit reached (max 10)',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const exact = await (this.prisma as any).measurementPoint.findFirst({
      where: {
        label: { equals: dto.label.trim(), mode: 'insensitive' },
        isActive: true,
      },
      select: { id: true, key: true, label: true },
    });

    if (exact) {
      throw new BadRequestException(`Measurement point already exists: ${exact.label}`);
    }

    const fuzzyMatches = await this.findFuzzyMatches(dto.label.trim());

    const now = new Date();
    const created = await (this.prisma as any).measurementPoint.create({
      data: {
        id: uuidv4(),
        key: this.buildKeyFromLabel(normalizedLabel, brandId),
        label: dto.label.trim(),
        description: dto.description?.trim() || null,
        category: dto.category,
        gender: dto.gender ?? null,
        source: 'BRAND_FREEFORM',
        status: 'BRAND_ONLY',
        brandId,
        minValueCm: dto.minValueCm ?? null,
        maxValueCm: dto.maxValueCm ?? null,
        submittedAt: now,
        sortOrder: 999,
        isActive: true,
      },
    });

    await this.bustCache();

    return {
      point: this.mapPoint(created as MeasurementPointRow),
      fuzzyMatches,
    };
  }

  async bustCache() {
    if (!this.redis) return;

    const keys = await this.redis.keys('mp:registry:*');
    if (keys.length) {
      await this.redis.del(keys);
    }
  }
}
