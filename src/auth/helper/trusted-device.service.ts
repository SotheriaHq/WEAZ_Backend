import { Injectable } from '@nestjs/common';
import { Request } from 'express';
import { createHash } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';

export type DeviceSignals = {
  ip: string;
  userAgent: string;
  platform: string;
  acceptLanguage: string;
};

@Injectable()
export class TrustedDeviceService {
  constructor(private readonly prisma: PrismaService) {}

  private isDeviceSignals(
    value: Request | DeviceSignals,
  ): value is DeviceSignals {
    return typeof (value as DeviceSignals).acceptLanguage === 'string';
  }

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

  private buildFingerprint(signals: DeviceSignals): string {
    const userAgent = String(signals.userAgent ?? 'unknown')
      .toLowerCase()
      .trim();
    const platform = String(signals.platform ?? 'unknown')
      .toLowerCase()
      .trim();
    const acceptLanguage = String(signals.acceptLanguage ?? 'unknown')
      .split(',')[0]
      .toLowerCase()
      .trim();

    return this.hash(`${userAgent}|${platform}|${acceptLanguage}`);
  }

  /**
   * Snapshot the request fields this service needs.
   *
   * Callers that record a device AFTER responding (login defers it off the
   * critical path) must capture these first: `req.socket` can be torn down once
   * the response is sent, and reading `remoteAddress` from a destroyed socket
   * yields nothing, which would silently poison the device's IP hash.
   */
  captureSignals(req: Request): DeviceSignals {
    return {
      ip: this.extractClientIp(req),
      userAgent: String(req.headers['user-agent'] ?? ''),
      platform: String(
        req.headers['sec-ch-ua-platform'] ??
          req.headers['x-client-platform'] ??
          '',
      ),
      acceptLanguage: String(req.headers['accept-language'] ?? ''),
    };
  }

  async recordLoginDevice(
    userId: string,
    source: Request | DeviceSignals,
  ): Promise<{ isNewDevice: boolean }> {
    const signals = this.isDeviceSignals(source)
      ? source
      : this.captureSignals(source);
    const fingerprintHash = this.buildFingerprint(signals);
    const normalizedIp = this.normalizeIp(signals.ip || 'unknown');
    const lastIpHash = this.hash(normalizedIp);
    const lastUserAgent = String(signals.userAgent ?? '').slice(0, 250);

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
    const existing = await this.prisma.trustedDevice.findFirst({
      where: {
        id: deviceId,
        userId,
      },
      select: { revokedAt: true },
    });

    if (!existing) {
      return { success: false };
    }

    if (existing.revokedAt) {
      return { success: true, alreadyRevoked: true };
    }

    await this.prisma.trustedDevice.update({
      where: { id: deviceId },
      data: {
        revokedAt: new Date(),
        isTrusted: false,
      },
    });

    return { success: true };
  }
}
