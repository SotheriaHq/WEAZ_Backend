import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';

@Injectable()
export class FeatureFlagsService {
  private readonly logger = new Logger(FeatureFlagsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.featureFlag.findMany({
      orderBy: { key: 'asc' },
    });
  }

  async toggle(
    flagId: string,
    isEnabled: boolean,
    actorId: string,
    req: Request,
  ) {
    const flag = await this.prisma.featureFlag.findUnique({
      where: { id: flagId },
    });
    if (!flag) throw new NotFoundException('Feature flag not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.featureFlag.update({
        where: { id: flagId },
        data: { isEnabled },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_FEATURE_FLAG_TOGGLE,
          targetType: 'FeatureFlag',
          targetId: flagId,
          previousState: { isEnabled: flag.isEnabled },
          newState: { isEnabled },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  async create(
    dto: { key: string; description?: string; isEnabled?: boolean },
    actorId: string,
    req: Request,
  ) {
    const flag = await this.prisma.$transaction(async (tx) => {
      const result = await tx.featureFlag.create({
        data: {
          id: uuidv4(),
          key: dto.key,
          description: dto.description ?? null,
          isEnabled: dto.isEnabled ?? false,
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_FEATURE_FLAG_TOGGLE,
          targetType: 'FeatureFlag',
          targetId: result.id,
          newState: { key: dto.key, isEnabled: dto.isEnabled ?? false },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return flag;
  }

  /**
   * Check if a feature flag is enabled (for runtime checks).
   */
  async isEnabled(key: string): Promise<boolean> {
    const flag = await this.prisma.featureFlag.findUnique({
      where: { key },
      select: { isEnabled: true },
    });
    return flag?.isEnabled ?? false;
  }
}
