import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Prisma,
  PushDeviceToken,
  PushPlatform,
  PushProvider,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  DeactivateCurrentPushTokenDto,
  RegisterPushTokenDto,
} from './push-token.dto';

const USER_LOGOUT_DISABLED_REASON = 'USER_LOGOUT';
const USER_DISABLED_REASON = 'USER_DISABLED';
const OPTIONAL_METADATA_FIELDS = [
  'deviceId',
  'deviceName',
  'appVersion',
  'expoProjectId',
] as const;

type PushTokenMetadataField = (typeof OPTIONAL_METADATA_FIELDS)[number];
type PushTokenMetadataCreate = Partial<
  Pick<Prisma.PushDeviceTokenUncheckedCreateInput, PushTokenMetadataField>
>;
type PushTokenMetadataUpdate = Partial<
  Pick<Prisma.PushDeviceTokenUncheckedUpdateInput, PushTokenMetadataField>
>;

type SafePushDeviceToken = {
  id: string;
  maskedToken: string;
  provider: PushProvider;
  platform: PushPlatform;
  deviceName: string | null;
  appVersion: string | null;
  isActive: boolean;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class PushDeviceTokensService {
  constructor(private readonly prisma: PrismaService) {}

  async register(userId: string, dto: RegisterPushTokenDto) {
    const token = this.normalizeToken(dto.token);
    const provider = dto.provider ?? PushProvider.EXPO;
    const platform = dto.platform ?? PushPlatform.UNKNOWN;
    const now = new Date();
    const metadata = this.buildMetadataData(dto);
    const createData: Prisma.PushDeviceTokenUncheckedCreateInput = {
      userId,
      token,
      provider,
      platform,
      ...metadata.create,
      isActive: true,
      lastSeenAt: now,
      disabledReason: null,
    };
    const updateData: Prisma.PushDeviceTokenUncheckedUpdateInput = {
      userId,
      provider,
      platform,
      ...metadata.update,
      isActive: true,
      lastSeenAt: now,
      disabledReason: null,
    };

    // `token` is globally unique, so a physical device token can only belong to
    // one user at a time. Registration transfers ownership to the current user
    // instead of deleting/recreating rows, preserving failure history and
    // preventing the previous user from receiving pushes for this device later.
    const record = await this.prisma.pushDeviceToken.upsert({
      where: { token },
      create: createData,
      update: updateData,
    });

    return this.toSafeResponse(record);
  }

  async deactivateCurrent(
    userId: string,
    tokenOrDto: string | DeactivateCurrentPushTokenDto,
  ) {
    const token =
      typeof tokenOrDto === 'string'
        ? this.normalizeToken(tokenOrDto)
        : this.normalizeToken(tokenOrDto.token);

    await this.prisma.pushDeviceToken.updateMany({
      where: { userId, token },
      data: {
        isActive: false,
        disabledReason: USER_LOGOUT_DISABLED_REASON,
      },
    });

    return { success: true };
  }

  async listMine(userId: string) {
    const tokens = await this.prisma.pushDeviceToken.findMany({
      where: { userId },
      orderBy: [{ isActive: 'desc' }, { lastSeenAt: 'desc' }],
      select: {
        id: true,
        token: true,
        provider: true,
        platform: true,
        deviceName: true,
        appVersion: true,
        isActive: true,
        lastSeenAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      items: tokens.map((token) => this.toSafeResponse(token)),
    };
  }

  async deactivateById(userId: string, id: string) {
    await this.prisma.pushDeviceToken.updateMany({
      where: { id, userId },
      data: {
        isActive: false,
        disabledReason: USER_DISABLED_REASON,
      },
    });

    return { success: true };
  }

  private normalizeToken(token: unknown) {
    const normalized = typeof token === 'string' ? token.trim() : '';
    if (!normalized) {
      throw new BadRequestException('Push token is required');
    }
    return normalized;
  }

  private buildMetadataData(dto: RegisterPushTokenDto): {
    create: PushTokenMetadataCreate;
    update: PushTokenMetadataUpdate;
  } {
    const create: PushTokenMetadataCreate = {};
    const update: PushTokenMetadataUpdate = {};

    for (const field of OPTIONAL_METADATA_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(dto, field)) {
        continue;
      }

      const normalized = this.normalizeOptionalString(dto[field]);
      if (normalized !== undefined) {
        create[field] = normalized;
        update[field] = normalized;
      } else {
        update[field] = null;
      }
    }

    return {
      create,
      update,
    };
  }

  private normalizeOptionalString(value: unknown) {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private toSafeResponse(
    token: Pick<
      PushDeviceToken,
      | 'id'
      | 'token'
      | 'provider'
      | 'platform'
      | 'deviceName'
      | 'appVersion'
      | 'isActive'
      | 'lastSeenAt'
      | 'createdAt'
      | 'updatedAt'
    >,
  ): SafePushDeviceToken {
    return {
      id: token.id,
      maskedToken: this.maskToken(token.token),
      provider: token.provider,
      platform: token.platform,
      deviceName: token.deviceName,
      appVersion: token.appVersion,
      isActive: token.isActive,
      lastSeenAt: token.lastSeenAt,
      createdAt: token.createdAt,
      updatedAt: token.updatedAt,
    };
  }

  private maskToken(token: string) {
    const normalized = token.trim();
    if (normalized.length <= 10) {
      return `${normalized.slice(0, 2)}...${normalized.slice(-2)}`;
    }
    return `${normalized.slice(0, 8)}...${normalized.slice(-6)}`;
  }
}
