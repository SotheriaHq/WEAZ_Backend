import { Injectable } from '@nestjs/common';
import { Request } from 'express';
import { createHash } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class TrustedDeviceService {
  constructor(private readonly prisma: PrismaService) {}

  private extractClientIp(req: Request): string {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  private normalizeIp(ip: string): string {
    const normalized = ip.trim();
    if (normalized.includes(':')) {
      // IPv6: keep coarse first four segments
      const segments = normalized.split(':').filter(Boolean);
      return segments.slice(0, 4).join(':');
    }

    const parts = normalized.split('.');
    if (parts.length !== 4) {
      return normalized;
    }

    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private buildFingerprint(req: Request): string {
    const userAgent = String(req.headers['user-agent'] ?? 'unknown').toLowerCase().trim();
    const platform = String(req.headers['sec-ch-ua-platform'] ?? req.headers['x-client-platform'] ?? 'unknown')
      .toLowerCase()
      .trim();
    const acceptLanguage = String(req.headers['accept-language'] ?? 'unknown')
      .split(',')[0]
      .toLowerCase()
      .trim();

    return this.hash(`${userAgent}|${platform}|${acceptLanguage}`);
  }

  async recordLoginDevice(userId: string, req: Request): Promise<{ isNewDevice: boolean }> {
    const fingerprintHash = this.buildFingerprint(req);
    const normalizedIp = this.normalizeIp(this.extractClientIp(req));
    const lastIpHash = this.hash(normalizedIp);
    const lastUserAgent = String(req.headers['user-agent'] ?? '').slice(0, 250);

    const existing = await this.prisma.trustedDevice.findUnique({
      where: {
        userId_fingerprintHash: {
          userId,
          fingerprintHash,
        },
      },
      select: { id: true, revokedAt: true },
    });

    if (!existing) {
      await this.prisma.trustedDevice.create({
        data: {
          userId,
          fingerprintHash,
          lastIpHash,
          lastUserAgent,
          isTrusted: false,
        },
      });
      return { isNewDevice: true };
    }

    await this.prisma.trustedDevice.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: new Date(),
        lastIpHash,
        lastUserAgent,
      },
    });

    return { isNewDevice: existing.revokedAt !== null };
  }

  async listDevices(userId: string) {
    return this.prisma.trustedDevice.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        deviceLabel: true,
        firstSeenAt: true,
        lastSeenAt: true,
        lastUserAgent: true,
        isTrusted: true,
        revokedAt: true,
      },
    });
  }

  async revokeDevice(userId: string, deviceId: string) {
    const result = await this.prisma.trustedDevice.updateMany({
      where: {
        id: deviceId,
        userId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        isTrusted: false,
      },
    });

    return { success: result.count > 0 };
  }
}
