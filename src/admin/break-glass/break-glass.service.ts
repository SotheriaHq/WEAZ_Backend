import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes, createHash } from 'crypto';
import * as bcrypt from 'bcrypt';
import { Request } from 'express';

const MAX_FAILURES_PER_DAY = 2;

@Injectable()
export class BreakGlassService {
  private readonly logger = new Logger(BreakGlassService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Attempt break-glass emergency access.
   * Uses raw socket IP (ignores X-Forwarded-For).
   */
  async attempt(code: string, req: Request) {
    const rawIp = req.socket?.remoteAddress ?? 'unknown';
    const now = new Date();

    // Check daily failure count for this IP
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const failureCount = await this.prisma.adminAuditLog.count({
      where: {
        action: AdminAuditAction.ADMIN_BREAK_GLASS_FAILURE,
        ipAddress: rawIp,
        createdAt: { gte: todayStart },
      },
    });

    if (failureCount >= MAX_FAILURES_PER_DAY) {
      throw new UnauthorizedException(
        'Break-glass endpoint locked for today due to failed attempts',
      );
    }

    // Find valid code for today
    const validCode = await this.prisma.breakGlassCode.findFirst({
      where: {
        validFrom: { lte: now },
        validUntil: { gt: now },
        usedAt: null,
      },
      orderBy: { validFrom: 'desc' },
    });

    if (!validCode) {
      await this.logAttempt(rawIp, req, false);
      throw new UnauthorizedException('Invalid or expired break-glass code');
    }

    const isValid = await bcrypt.compare(code, validCode.codeHash);
    if (!isValid) {
      await this.logAttempt(rawIp, req, false);
      throw new UnauthorizedException('Invalid break-glass code');
    }

    // Mark code as used
    await this.prisma.breakGlassCode.update({
      where: { id: validCode.id },
      data: { usedAt: now, usedByIp: rawIp },
    });

    await this.logAttempt(rawIp, req, true);

    return {
      success: true,
      message:
        'Break-glass access granted. Temporary SuperAdmin session expires in 30 minutes. Create or reactivate a proper SuperAdmin account immediately.',
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    };
  }

  /**
   * Generate a new daily break-glass code (called by scheduled job).
   */
  async generateDailyCode(): Promise<string> {
    const code = randomBytes(16).toString('base64url');
    const codeHash = await bcrypt.hash(code, 10);

    const now = new Date();
    const validFrom = new Date(now);
    validFrom.setHours(0, 0, 0, 0);
    const validUntil = new Date(validFrom);
    validUntil.setDate(validUntil.getDate() + 1);

    await this.prisma.breakGlassCode.create({
      data: {
        id: uuidv4(),
        codeHash,
        validFrom,
        validUntil,
      },
    });

    return code;
  }

  private async logAttempt(ip: string, req: Request, success: boolean) {
    await this.prisma.adminAuditLog.create({
      data: {
        id: uuidv4(),
        actorUserId: '00000000-0000-0000-0000-000000000000', // System actor for break-glass
        action: success
          ? AdminAuditAction.ADMIN_BREAK_GLASS_SUCCESS
          : AdminAuditAction.ADMIN_BREAK_GLASS_FAILURE,
        ipAddress: ip,
        userAgent: req.headers['user-agent'] ?? null,
        metadata: { rawSocketIp: ip },
      },
    });
  }
}
