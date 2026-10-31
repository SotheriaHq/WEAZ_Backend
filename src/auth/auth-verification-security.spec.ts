import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuthService } from './auth.service';
import { VerifyEmailCodeDto } from './dto/verify-email-code.dto';

describe('Email verification boundary', () => {
  const token = 'a'.repeat(48);
  let service: AuthService;
  let prisma: { user: { findUnique: jest.Mock; update: jest.Mock } };

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn(), update: jest.fn() } };
    service = Object.create(AuthService.prototype) as AuthService;
    Object.assign(service, {
      prisma,
      notifications: { create: jest.fn().mockResolvedValue({}) },
    });
  });

  it.each([null, undefined, '', ' ', [], {}, 123, 'x'.repeat(257)])(
    'rejects invalid code %p before a database lookup',
    async (code) => {
      await expect(
        service.verifyEmailByCode('shopper@example.com', code as string),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    },
  );

  it('never verifies an unverified account with no stored code', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'shopper',
      isEmailVerified: false,
      emailVerificationCode: null,
    });
    await expect(
      service.verifyEmailByCode('shopper@example.com', token),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('preserves valid verification and consumes the matching code', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'shopper',
      isEmailVerified: false,
      emailVerificationCode: token,
    });
    await expect(
      service.verifyEmailByCode('shopper@example.com', token),
    ).resolves.toEqual({ message: 'Email verified successfully' });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { email: 'shopper@example.com' },
      data: { isEmailVerified: true, emailVerificationCode: null },
    });
  });

  it('rejects a null code on the alternate user-id link entry', async () => {
    await expect(
      service.verifyEmailByLink('shopper', null as unknown as string),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { email: 'shopper@example.com', code: null },
    { email: [], code: token },
    { email: 'bad', code: token },
  ])('rejects malformed HTTP verification payload %p', async (payload) => {
    expect(
      await validate(plainToInstance(VerifyEmailCodeDto, payload)),
    ).not.toHaveLength(0);
  });
});
