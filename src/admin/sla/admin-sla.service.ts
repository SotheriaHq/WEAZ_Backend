import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import {
  adminUserDisplaySelect,
  mapAdminUserDisplay,
} from '../admin-user-display.helper';

@Injectable()
export class AdminSlaService {
  private readonly logger = new Logger(AdminSlaService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const configs = await this.prisma.adminSlaConfig.findMany({
      orderBy: [{ area: 'asc' }, { createdAt: 'desc' }],
      include: {
        createdBy: {
          select: adminUserDisplaySelect,
        },
      },
    });
    return configs.map((config) => ({
      ...config,
      createdBy: mapAdminUserDisplay(config.createdBy),
    }));
  }

  async create(
    dto: {
      area: string;
      targetHours: number;
      startDate?: string;
      endDate?: string;
    },
    actorId: string,
    req: Request,
  ) {
    const config = await this.prisma.$transaction(async (tx) => {
      const result = await tx.adminSlaConfig.create({
        data: {
          id: uuidv4(),
          area: dto.area,
          targetHours: dto.targetHours,
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          endDate: dto.endDate ? new Date(dto.endDate) : null,
          createdById: actorId,
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_SLA_CREATE,
          targetType: 'AdminSlaConfig',
          targetId: result.id,
          newState: { area: dto.area, targetHours: dto.targetHours },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return config;
  }

  async update(
    configId: string,
    dto: { targetHours?: number; isActive?: boolean; endDate?: string },
    actorId: string,
    req: Request,
  ) {
    const config = await this.prisma.adminSlaConfig.findUnique({
      where: { id: configId },
    });
    if (!config) throw new NotFoundException('SLA config not found');

    const updateData: Record<string, unknown> = {};
    if (dto.targetHours !== undefined) updateData.targetHours = dto.targetHours;
    if (dto.isActive !== undefined) updateData.isActive = dto.isActive;
    if (dto.endDate !== undefined)
      updateData.endDate = dto.endDate ? new Date(dto.endDate) : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.adminSlaConfig.update({
        where: { id: configId },
        data: updateData,
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_SLA_UPDATE,
          targetType: 'AdminSlaConfig',
          targetId: configId,
          previousState: {
            targetHours: config.targetHours,
            isActive: config.isActive,
          },
          newState: updateData,
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  async delete(configId: string, actorId: string, req: Request) {
    const config = await this.prisma.adminSlaConfig.findUnique({
      where: { id: configId },
    });
    if (!config) throw new NotFoundException('SLA config not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.adminSlaConfig.delete({ where: { id: configId } });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_SLA_DELETE,
          targetType: 'AdminSlaConfig',
          targetId: configId,
          previousState: { area: config.area, targetHours: config.targetHours },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    });

    return { message: 'SLA config deleted' };
  }
}
