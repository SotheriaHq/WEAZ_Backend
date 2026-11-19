import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuthService } from './auth.service';
import { VerifyEmailCodeDto } from './dto/verify-email-code.dto';
import {
  EMAIL_LINK_TTL_MS,
  digestEmailToken,
  emailTokenExpired,
  issueExpiringEmailToken,
} from './email-link-policy';

describe('Email verification boundary', () => {
  const issued = issueExpiringEmailToken();
  const token = issued.token;
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

  it('verifies against the stored digest and consumes it', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'shopper',
      isEmailVerified: false,
      emailVerificationCode: issued.stored,
    });
    await expect(
      service.verifyEmailByCode('shopper@example.com', token),
    ).resolves.toEqual({ message: 'Email verified successfully' });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { email: 'shopper@example.com' },
      data: { isEmailVerified: true, emailVerificationCode: null },
    });
  });

  it('refuses the stored digest itself: a leaked row is not a working code', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'shopper',
      isEmailVerified: false,
      emailVerificationCode: issued.stored,
    });
    await expect(
      service.verifyEmailByCode('shopper@example.com', issued.stored),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses a matching code once it has expired', async () => {
    const stale = issueExpiringEmailToken(Date.now() - EMAIL_LINK_TTL_MS - 1);
    prisma.user.findUnique.mockResolvedValue({
      id: 'shopper',
      isEmailVerified: false,
      emailVerificationCode: stale.stored,
    });
    await expect(
      service.verifyEmailByLink('shopper', stale.token),
    ).rejects.toThrow(/expired/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('looks the emailed link up by digest and refuses it after 15 minutes', async () => {
    const stale = issueExpiringEmailToken(Date.now() - EMAIL_LINK_TTL_MS - 1);
    prisma.user.findUnique.mockResolvedValue({
      id: 'shopper',
      isEmailVerified: false,
      emailVerificationCode: stale.stored,
    });
    await expect(service.verifyEmailByToken(stale.token)).rejects.toThrow(
      /expired/,
    );
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { emailVerificationCode: digestEmailToken(stale.token) },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('answers a repeat click on a used link with "already verified", even after expiry', async () => {
    const stale = issueExpiringEmailToken(Date.now() - EMAIL_LINK_TTL_MS - 1);
    prisma.user.findUnique.mockResolvedValue({
      id: 'shopper',
      isEmailVerified: true,
      emailVerificationCode: stale.stored,
    });
    await expect(service.verifyEmailByToken(stale.token)).resolves.toEqual({
      message: 'Email already verified',
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('treats tokens issued before expiry existed as expired', () => {
    expect(emailTokenExpired('a'.repeat(48))).toBe(true);
    expect(emailTokenExpired(token)).toBe(false);
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
