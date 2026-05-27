import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AdminAuditAction, Role, UserStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { BreakGlassService } from './break-glass.service';

describe('BreakGlassService', () => {
  const req = {
    socket: { remoteAddress: '203.0.113.10' },
    headers: { 'user-agent': 'jest-agent' },
  } as any;
  const uaHash = createHash('sha256')
    .update('jest-agent')
    .digest('hex')
    .slice(0, 24);

  const buildService = (overrides?: { config?: Record<string, string>; prisma?: any; jwt?: any }) => {
    const config = overrides?.config ?? { NODE_ENV: 'test', JWT_ACCESS_SECRET: 'test-secret' };
    const prisma =
      overrides?.prisma ??
      ({
        adminAuditLog: {
          create: jest.fn().mockResolvedValue({}),
          count: jest.fn().mockResolvedValue(0),
          findFirst: jest.fn(),
        },
        breakGlassCode: { findFirst: jest.fn() },
        breakGlassRecoveryToken: {
          findUnique: jest.fn(),
          updateMany: jest.fn(),
          create: jest.fn(),
          deleteMany: jest.fn(),
        },
      } as any);
    const service = new BreakGlassService(
      prisma,
      overrides?.jwt ?? ({ verifyAsync: jest.fn(), signAsync: jest.fn() } as any),
      { get: jest.fn((key: string) => config[key]) } as any,
      { hashPassword: jest.fn().mockResolvedValue('hashed-password') } as any,
      { generateUniqueUsername: jest.fn().mockResolvedValue('ada-okafor') } as any,
      {
        getAppName: jest.fn(() => 'Threadly'),
        send: jest.fn().mockResolvedValue({
          outboxId: 'outbox_1',
          dispatchStatus: 'SENT',
          providerMessageId: 'message_1',
          errorMessage: null,
        }),
      } as any,
    );
    return { service, prisma };
  };

  it('is disabled by default in production and writes an audit event', async () => {
    const { service, prisma } = buildService({
      config: { NODE_ENV: 'production', JWT_ACCESS_SECRET: 'x'.repeat(32) },
    });

    await expect(service.attempt('valid-code-value', req)).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: AdminAuditAction.ADMIN_BREAK_GLASS_FAILURE,
          metadata: expect.objectContaining({ reason: 'break_glass_disabled' }),
        }),
      }),
    );
  });

  it('rejects invalid recovery requests and audits the failure', async () => {
    const { service, prisma } = buildService();

    await expect(
      service.recoverSuperAdmin(
        '',
        { email: 'admin@example.com', firstName: 'Ada', lastName: 'Okafor' },
        req,
      ),
    ).rejects.toThrow('Recovery token is required');
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ reason: 'missing_recovery_token' }),
        }),
      }),
    );
  });

  it('rate-limits repeated failed code attempts at the service layer', async () => {
    const { service, prisma } = buildService();
    prisma.adminAuditLog.count.mockResolvedValue(2);

    await expect(service.attempt('valid-code-value', req)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ reason: 'daily_failure_limit_reached' }),
        }),
      }),
    );
  });

  it('does not return a raw temporary SuperAdmin password', async () => {
    const jti = 'recovery-jti';
    const recoveredUser = {
      id: 'user_1',
      email: 'admin@example.com',
      role: Role.SuperAdmin,
      status: UserStatus.ACTIVE,
      username: 'ada-okafor',
    };
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(recoveredUser),
      },
      refreshToken: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const { service } = buildService({
      jwt: {
        verifyAsync: jest.fn().mockResolvedValue({
          purpose: 'breakglass_superadmin_recovery',
          ip: '203.0.113.10',
          uaHash,
          jti,
        }),
      },
      prisma: {
        adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
        breakGlassRecoveryToken: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'token_1',
            jtiHash: createHash('sha256').update(jti).digest('hex'),
            ipAddress: '203.0.113.10',
            userAgentHash: uaHash,
            usedAt: null,
            expiresAt: new Date(Date.now() + 60_000),
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        $transaction: jest.fn((callback) => callback(tx)),
      },
    });

    const result = await service.recoverSuperAdmin(
      'valid.jwt',
      { email: 'ADMIN@Example.com', firstName: 'Ada', lastName: 'Okafor' },
      req,
    );

    expect(result).not.toHaveProperty('temporaryPassword');
    expect(JSON.stringify(result)).not.toContain('hashed-password');
  });
});
