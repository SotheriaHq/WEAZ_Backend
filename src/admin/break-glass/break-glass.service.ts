import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction, Role, UserStatus, UserType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { Request } from 'express';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PasswordService } from 'src/auth/helper/password.service';
import { UserHelperService } from 'src/auth/helper/user-helper.service';

const MAX_FAILURES_PER_DAY = 2;
const BACKOFF_AFTER_FAILURE_MS = 30_000;
const RECOVERY_TOKEN_TTL_SECONDS = 30 * 60;

@Injectable()
export class BreakGlassService {
  private readonly logger = new Logger(BreakGlassService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly passwordService: PasswordService,
    private readonly userHelper: UserHelperService,
  ) {}

  private get recoveryTokenSecret(): string {
    const configuredSecret = this.configService.get<string>(
      'BREAK_GLASS_JWT_SECRET',
    );
    const accessSecret = this.configService.get<string>('JWT_ACCESS_SECRET');
    const secret = configuredSecret || accessSecret;
    if (!secret) {
      throw new Error(
        'BREAK_GLASS_JWT_SECRET or JWT_ACCESS_SECRET must be configured',
      );
    }
    return secret;
  }

  private extractRawSocketIp(req: Request): string {
    return req.socket?.remoteAddress ?? 'unknown';
  }

  private getUserAgent(req: Request): string | null {
    const raw = req.headers['user-agent'];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
    return null;
  }

  private hashUserAgent(userAgent: string | null): string {
    if (!userAgent) {
      return 'none';
    }
    return createHash('sha256').update(userAgent).digest('hex').slice(0, 24);
  }

  private async issueRecoveryToken(req: Request): Promise<string> {
    const ip = this.extractRawSocketIp(req);
    const uaHash = this.hashUserAgent(this.getUserAgent(req));
    const jti = uuidv4();
    const jtiHash = createHash('sha256').update(jti).digest('hex');

    await this.prisma.breakGlassRecoveryToken.create({
      data: {
        id: uuidv4(),
        jtiHash,
        ipAddress: ip,
        userAgentHash: uaHash,
        expiresAt: new Date(Date.now() + RECOVERY_TOKEN_TTL_SECONDS * 1000),
      },
    });

    return this.jwtService.signAsync(
      {
        purpose: 'breakglass_superadmin_recovery',
        ip,
        uaHash,
      },
      {
        secret: this.recoveryTokenSecret,
        expiresIn: RECOVERY_TOKEN_TTL_SECONDS,
        jwtid: jti,
      },
    );
  }

  /**
   * Attempt break-glass emergency access.
   * Uses raw socket IP (ignores X-Forwarded-For).
   */
  async attempt(code: string, req: Request) {
    const rawIp = this.extractRawSocketIp(req);
    const userAgent = this.getUserAgent(req);
    const now = new Date();

    if (!code || typeof code !== 'string' || code.trim().length < 8) {
      throw new BadRequestException('A valid break-glass code is required');
    }

    // Check daily failure count for this socket-IP + user-agent pair
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const failureWhere = {
      action: AdminAuditAction.ADMIN_BREAK_GLASS_FAILURE,
      ipAddress: rawIp,
      userAgent,
      createdAt: { gte: todayStart },
    };

    const failureCount = await this.prisma.adminAuditLog.count({
      where: failureWhere,
    });

    if (failureCount >= MAX_FAILURES_PER_DAY) {
      throw new UnauthorizedException(
        'Break-glass endpoint locked for today due to failed attempts',
      );
    }

    // Backoff after first failure to reduce brute force pressure
    if (failureCount > 0) {
      const lastFailure = await this.prisma.adminAuditLog.findFirst({
        where: failureWhere,
        orderBy: { createdAt: 'desc' },
      });
      if (lastFailure) {
        const elapsed = now.getTime() - lastFailure.createdAt.getTime();
        if (elapsed < BACKOFF_AFTER_FAILURE_MS) {
          const retryAfterSeconds = Math.ceil(
            (BACKOFF_AFTER_FAILURE_MS - elapsed) / 1000,
          );
          throw new UnauthorizedException(
            `Retry break-glass after ${retryAfterSeconds} seconds`,
          );
        }
      }
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
      await this.logAttempt(rawIp, userAgent, req, false);
      throw new UnauthorizedException('Invalid or expired break-glass code');
    }

    const isValid = await bcrypt.compare(code, validCode.codeHash);
    if (!isValid) {
      await this.logAttempt(rawIp, userAgent, req, false);
      throw new UnauthorizedException('Invalid break-glass code');
    }

    // Mark code as used
    await this.prisma.breakGlassCode.update({
      where: { id: validCode.id },
      data: { usedAt: now, usedByIp: rawIp },
    });

    const recoveryToken = await this.issueRecoveryToken(req);
    const expiresAt = new Date(
      now.getTime() + RECOVERY_TOKEN_TTL_SECONDS * 1000,
    ).toISOString();

    await this.logAttempt(rawIp, userAgent, req, true, {
      recoveryTokenExpiresAt: expiresAt,
      stage: 'code_verified',
    });

    return {
      success: true,
      message:
        'Break-glass code verified. Use the recovery token to create/reactivate a SuperAdmin account.',
      recoveryToken,
      expiresAt,
    };
  }

  /**
   * Recover a SuperAdmin account using a valid break-glass recovery token.
   */
  async recoverSuperAdmin(
    recoveryToken: string,
    dto: { email: string; firstName: string; lastName: string },
    req: Request,
  ) {
    if (!recoveryToken || typeof recoveryToken !== 'string') {
      throw new BadRequestException('Recovery token is required');
    }

    const normalizedEmail = dto.email?.trim().toLowerCase();
    const firstName = dto.firstName?.trim();
    const lastName = dto.lastName?.trim();

    if (!normalizedEmail || !firstName || !lastName) {
      throw new BadRequestException(
        'email, firstName, and lastName are required',
      );
    }

    let payload: { purpose?: string; ip?: string; uaHash?: string; jti?: string };
    try {
      payload = await this.jwtService.verifyAsync(recoveryToken, {
        secret: this.recoveryTokenSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired recovery token');
    }

    const requestIp = this.extractRawSocketIp(req);
    const requestUaHash = this.hashUserAgent(this.getUserAgent(req));
    if (
      payload.purpose !== 'breakglass_superadmin_recovery' ||
      payload.ip !== requestIp ||
      payload.uaHash !== requestUaHash
    ) {
      throw new UnauthorizedException('Recovery token context mismatch');
    }

    if (!payload.jti) {
      throw new UnauthorizedException('Invalid recovery token');
    }

    const jtiHash = createHash('sha256').update(payload.jti).digest('hex');
    const tokenRecord = await this.prisma.breakGlassRecoveryToken.findUnique({
      where: { jtiHash },
    });
    if (
      !tokenRecord ||
      tokenRecord.usedAt !== null ||
      tokenRecord.expiresAt <= new Date()
    ) {
      throw new UnauthorizedException('Recovery token already used or expired');
    }
    if (
      tokenRecord.ipAddress !== requestIp ||
      tokenRecord.userAgentHash !== requestUaHash
    ) {
      throw new UnauthorizedException('Recovery token context mismatch');
    }

    const consumed = await this.prisma.breakGlassRecoveryToken.updateMany({
      where: { id: tokenRecord.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new UnauthorizedException('Recovery token already used');
    }

    const temporaryPassword = randomBytes(16).toString('base64url');
    const hashedPassword = await this.passwordService.hashPassword(
      temporaryPassword,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      const existingUser = await tx.user.findUnique({
        where: { email: normalizedEmail },
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          username: true,
        },
      });

      let recoveredUser:
        | {
            id: string;
            email: string;
            role: Role;
            status: UserStatus;
            username: string;
          }
        | undefined;

      if (existingUser) {
        recoveredUser = await tx.user.update({
          where: { id: existingUser.id },
          data: {
            role: Role.SuperAdmin,
            status: UserStatus.ACTIVE,
            isActive: 'Active',
            firstName,
            lastName,
            password: hashedPassword,
            mustResetPassword: true,
            authVersion: { increment: 1 },
            adminSuspendedAt: null,
            adminSuspendedReason: null,
            deactivatedAt: null,
            deactivatedReason: null,
          },
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
            username: true,
          },
        });
      } else {
        const username = await this.userHelper.generateUniqueUsername(
          firstName,
          lastName,
        );
        recoveredUser = await tx.user.create({
          data: {
            id: uuidv4(),
            username,
            email: normalizedEmail,
            firstName,
            lastName,
            password: hashedPassword,
            role: Role.SuperAdmin,
            type: UserType.REGULAR,
            status: UserStatus.ACTIVE,
            isActive: 'Active',
            mustResetPassword: true,
          },
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
            username: true,
          },
        });
      }

      await tx.refreshToken.deleteMany({ where: { userId: recoveredUser.id } });

      await tx.adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: recoveredUser.id,
          action: AdminAuditAction.ADMIN_BREAK_GLASS_SUCCESS,
          targetType: 'User',
          targetId: recoveredUser.id,
          ipAddress: requestIp,
          userAgent: this.getUserAgent(req),
          metadata: {
            stage: 'superadmin_recovered',
            email: normalizedEmail,
          },
          newState: {
            role: recoveredUser.role,
            status: recoveredUser.status,
            mustResetPassword: true,
          },
        },
      });

      return recoveredUser;
    });

    return {
      success: true,
      user: result,
      temporaryPassword,
      message:
        'SuperAdmin recovery completed. Sign in with the temporary password and reset it immediately.',
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

  async pruneExpiredRecoveryTokens() {
    await this.prisma.breakGlassRecoveryToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },
          {
            usedAt: {
              lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
          },
        ],
      },
    });
  }

  private async logAttempt(
    ip: string,
    userAgent: string | null,
    req: Request,
    success: boolean,
    metadata?: Record<string, unknown>,
  ) {
    await this.prisma.adminAuditLog.create({
      data: {
        id: uuidv4(),
        actorUserId: '00000000-0000-0000-0000-000000000000', // System actor for break-glass
        action: success
          ? AdminAuditAction.ADMIN_BREAK_GLASS_SUCCESS
          : AdminAuditAction.ADMIN_BREAK_GLASS_FAILURE,
        ipAddress: ip,
        userAgent,
        metadata: {
          rawSocketIp: ip,
          userAgentHash: this.hashUserAgent(userAgent),
          ...(metadata ?? {}),
        },
      },
    });
  }
}
