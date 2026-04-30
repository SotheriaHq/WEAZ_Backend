import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { StudioHandoffService } from './studio-handoff.service';

jest.mock('bcrypt', () => ({
  hash: jest.fn(),
  compare: jest.fn(),
}));

const req = {
  ip: '127.0.0.1',
  socket: { remoteAddress: '127.0.0.1' },
  headers: { 'user-agent': 'jest' },
} as any;

const res = {} as any;

describe('StudioHandoffService', () => {
  const prisma = {
    studioHandoffCode: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const tokenService = {
    generateWebSessionForUserId: jest.fn(),
  };
  let service: StudioHandoffService;

  beforeEach(() => {
    jest.clearAllMocks();
    (bcrypt.hash as jest.Mock).mockResolvedValue('hashed-secret');
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    prisma.studioHandoffCode.deleteMany.mockResolvedValue({ count: 0 });
    tokenService.generateWebSessionForUserId.mockResolvedValue({ accessToken: 'access' });
    service = new StudioHandoffService(prisma as any, tokenService as any);
  });

  it('rejects unauthenticated create requests', async () => {
    await expect(
      service.create({ id: '' }, '/studio', req),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects non-brand create requests', async () => {
    await expect(
      service.create({ id: 'user-1', type: 'REGULAR' }, '/studio', req),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects non-studio create paths', async () => {
    await expect(
      service.create({ id: 'user-1', type: 'BRAND' }, '/profile', req),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects studio paths that are not part of the mobile handoff allowlist', async () => {
    await expect(
      service.create({ id: 'user-1', type: 'BRAND' }, '/studio/admin/unsafe', req),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unsupported studio tabs', async () => {
    await expect(
      service.create({ id: 'user-1', type: 'BRAND' }, '/studio?tab=unsafe', req),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects arbitrary handoff query params on studio paths', async () => {
    await expect(
      service.create(
        { id: 'user-1', type: 'BRAND' },
        '/studio/store/products/new?returnTo=https%3A%2F%2Fexample.com',
        req,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects arbitrary handoff query params on studio tab routes', async () => {
    await expect(
      service.create({ id: 'user-1', type: 'BRAND' }, '/studio?tab=orders&next=/profile', req),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates one-time handoff codes with hashed secret only', async () => {
    const result = await service.create({ id: 'user-1', type: 'BRAND' }, '/studio/store', req);

    expect(result.code).toContain('.');
    expect(prisma.studioHandoffCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          codeHash: 'hashed-secret',
          userId: 'user-1',
          intendedPath: '/studio/store',
        }),
      }),
    );
    expect(prisma.studioHandoffCode.create.mock.calls[0][0].data.codeHash).not.toContain(
      result.code.split('.')[1],
    );
  });

  it('creates a valid brand handoff for the Studio overview', async () => {
    const result = await service.create({ id: 'user-1', type: 'BRAND' }, '/studio', req);

    expect(result.intendedPath).toBe('/studio');
    expect(result.expiresAt).toEqual(expect.any(String));
    expect(result.code).toContain('.');
    expect(prisma.studioHandoffCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          intendedPath: '/studio',
        }),
      }),
    );
  });

  it('allows supported studio tab routes', async () => {
    const result = await service.create(
      { id: 'user-1', type: 'BRAND' },
      '/studio?tab=orders',
      req,
    );

    expect(result.intendedPath).toBe('/studio?tab=orders');
  });

  it('rejects missing or malformed exchange codes', async () => {
    await expect(service.exchange('', req, res)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.exchange('too.many.parts', req, res)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects expired codes', async () => {
    prisma.studioHandoffCode.findUnique.mockResolvedValue({
      id: 'code-id',
      usedAt: null,
      expiresAt: new Date(Date.now() - 1000),
      user: { type: 'BRAND', status: 'ACTIVE' },
    });

    await expect(service.exchange('code-id.secret', req, res)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects reused codes', async () => {
    prisma.studioHandoffCode.findUnique.mockResolvedValue({
      id: 'code-id',
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
      user: { type: 'BRAND', status: 'ACTIVE' },
    });

    await expect(service.exchange('code-id.secret', req, res)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('exchanges a valid code once and creates a web session', async () => {
    prisma.studioHandoffCode.findUnique.mockResolvedValue({
      id: 'code-id',
      userId: 'user-1',
      codeHash: 'hashed-secret',
      usedAt: null,
      expiresAt: new Date(Date.now() + 1000),
      intendedPath: '/studio/store',
      user: { type: 'BRAND', status: 'ACTIVE' },
    });
    prisma.studioHandoffCode.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.exchange('code-id.secret', req, res);

    expect(bcrypt.compare).toHaveBeenCalledWith('secret', 'hashed-secret');
    expect(tokenService.generateWebSessionForUserId).toHaveBeenCalledWith('user-1', req, res);
    expect(result).toEqual({ accessToken: 'access', intendedPath: '/studio/store' });
  });

  it('rejects race-lost exchanges', async () => {
    prisma.studioHandoffCode.findUnique.mockResolvedValue({
      id: 'code-id',
      userId: 'user-1',
      codeHash: 'hashed-secret',
      usedAt: null,
      expiresAt: new Date(Date.now() + 1000),
      intendedPath: '/studio/store',
      user: { type: 'BRAND', status: 'ACTIVE' },
    });
    prisma.studioHandoffCode.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.exchange('code-id.secret', req, res)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
