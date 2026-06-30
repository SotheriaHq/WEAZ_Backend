import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EmailService } from './email.service';
import { PrismaService } from 'src/prisma/prisma.service';

const mockResendSend = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: mockResendSend,
    },
  })),
}));

describe('EmailService', () => {
  const createConfig = (
    overrides: Record<string, string | undefined> = {},
  ): ConfigService => {
    const values: Record<string, string | undefined> = {
      APP_NAME: 'WIEZ',
      EMAIL_PROVIDER: 'resend',
      EMAIL_MODE: 'live',
      RESEND_API_KEY: 're_test_key',
      RESEND_FROM: 'WIEZ <noreply@wiez.me>',
      RESEND_REPLY_TO: 'support@wiez.me',
      EMAIL_DAILY_LIMIT: undefined,
      EMAIL_LOG_INTENDED_RECIPIENT: 'false',
      ...overrides,
    };

    return {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
  };

  const createPrisma = (sentToday = 0): PrismaService =>
    ({
      emailOutbox: {
        create: jest.fn().mockResolvedValue({ id: 'outbox-1' }),
      },
      emailDeliveryAttempt: {
        count: jest.fn().mockResolvedValue(sentToday),
      },
    }) as unknown as PrismaService;

  const createService = (
    overrides?: Record<string, string | undefined>,
    prisma = createPrisma(),
  ) => new EmailService(createConfig(overrides), prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    mockResendSend.mockResolvedValue({
      data: { id: 'resend-msg-1' },
      error: null,
      headers: null,
    });
  });

  it('redacts configured sender address in operational logs', () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    createService({
      RESEND_FROM: 'Private Sender <private.sender@example.com>',
    });

    const emittedLogs = logSpy.mock.calls
      .map((entry) => String(entry[0] ?? ''))
      .join('\n');

    expect(emittedLogs).not.toContain('private.sender@example.com');
    expect(emittedLogs).toContain('email_fingerprint=');

    logSpy.mockRestore();
  });

  it('fails closed when live mode is missing RESEND_API_KEY', async () => {
    const service = createService({ RESEND_API_KEY: undefined });

    await expect(
      service.sendNow('recipient@example.com', 'Verify', '<p>Verify</p>'),
    ).rejects.toThrow('RESEND_CONFIG_MISSING: RESEND_API_KEY');
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('fails closed when live mode is missing RESEND_FROM', async () => {
    const service = createService({ RESEND_FROM: undefined });

    await expect(
      service.sendNow('recipient@example.com', 'Verify', '<p>Verify</p>'),
    ).rejects.toThrow('RESEND_CONFIG_MISSING: RESEND_FROM');
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('fails closed when redirect mode is missing SIT_EMAIL_REDIRECT_TO', async () => {
    const service = createService({
      EMAIL_MODE: 'redirect',
      SIT_EMAIL_REDIRECT_TO: undefined,
    });

    await expect(
      service.sendNow('recipient@example.com', 'Verify', '<p>Verify</p>'),
    ).rejects.toThrow('SIT_EMAIL_REDIRECT_TO');
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('falls back to log_only for invalid EMAIL_MODE and does not call Resend', async () => {
    const service = createService({
      EMAIL_MODE: 'invalid',
      RESEND_API_KEY: undefined,
      RESEND_FROM: undefined,
    });

    const result = await service.sendNow(
      'recipient@example.com',
      'Verify',
      '<p>Verify</p>',
    );

    expect(result.providerMessageId).toBe('log-only');
    expect(result.emailMode).toBe('log_only');
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('log_only does not call Resend or log email bodies and tokens', async () => {
    const service = createService({ EMAIL_MODE: 'log_only' });
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const debugSpy = jest
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);

    await service.sendNow(
      'recipient@example.com',
      'Reset your password',
      '<p>https://app.wiez.me/reset-password?token=secret-token-value</p>',
      'Use OTP 123456',
    );

    const emittedLogs = [...logSpy.mock.calls, ...debugSpy.mock.calls]
      .map((entry) => String(entry[0] ?? ''))
      .join('\n');

    expect(mockResendSend).not.toHaveBeenCalled();
    expect(emittedLogs).not.toContain('secret-token-value');
    expect(emittedLogs).not.toContain('123456');
    expect(emittedLogs).not.toContain('<p>');

    logSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it('log_only stores body placeholders when enqueuing outbox rows', async () => {
    const prisma = createPrisma();
    const service = createService({ EMAIL_MODE: 'log_only' }, prisma);

    const result = await service.send(
      'recipient@example.com',
      'Reset your password',
      '<p>https://app.wiez.me/reset-password?token=secret-token-value</p>',
      'Use OTP 123456',
    );

    expect(result.dispatchStatus).toBe('QUEUED');
    expect((prisma as any).emailOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          html: '<p>Email body omitted in log_only mode.</p>',
          text: 'Email body omitted in log_only mode.',
        }),
      }),
    );
    const storedData = (prisma as any).emailOutbox.create.mock.calls[0][0].data;
    expect(storedData.html).not.toContain('secret-token-value');
    expect(storedData.text).not.toContain('123456');
  });

  it('redirect sends only to SIT_EMAIL_REDIRECT_TO, preserves subject branding, and masks the intended recipient by default', async () => {
    const service = createService({
      EMAIL_MODE: 'redirect',
      SIT_EMAIL_REDIRECT_TO: 'sit-inbox@example.com',
    });

    const result = await service.sendNow(
      'recipient@example.com',
      "✨ You're almost in — confirm your WIEZ email",
      '<p>Verify</p>',
      'Verify',
      { idempotencyKey: 'outbox:1' },
    );

    expect(result.providerMessageId).toBe('resend-msg-1');
    expect(result.emailMode).toBe('redirect');
    expect(mockResendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'WIEZ <noreply@wiez.me>',
        to: 'sit-inbox@example.com',
        subject: "✨ You're almost in — confirm your WIEZ email",
        html: '<p>Verify</p>',
        text: 'Verify',
        replyTo: 'support@wiez.me',
      }),
      { idempotencyKey: 'outbox:1' },
    );
    expect(mockResendSend.mock.calls[0][0].to).not.toBe(
      'recipient@example.com',
    );
    expect(mockResendSend.mock.calls[0][0].subject).not.toContain(
      'recipient@example.com',
    );
    expect(mockResendSend.mock.calls[0][0].subject).not.toContain('[SIT');
    expect(mockResendSend.mock.calls[0][0].subject).not.toContain(
      'email_fingerprint=',
    );
    expect(mockResendSend.mock.calls[0][0].subject).not.toContain('REDIRECT');
  });

  it('live sends to the intended recipient through Resend', async () => {
    const service = createService();

    const result = await service.sendNow(
      'recipient@example.com',
      "✨ You're almost in — confirm your WIEZ email",
      '<p>Verify</p>',
      'Verify',
      { idempotencyKey: 'outbox:2' },
    );

    expect(result.providerMessageId).toBe('resend-msg-1');
    expect(result.emailMode).toBe('live');
    expect(service.getDeliveryAttemptProvider()).toBe('RESEND');
    expect(service.getTransportHost()).toBe('api.resend.com');
    expect(mockResendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'recipient@example.com',
        subject: "✨ You're almost in — confirm your WIEZ email",
      }),
      { idempotencyKey: 'outbox:2' },
    );
  });

  it('blocks real sends after EMAIL_DAILY_LIMIT is reached', async () => {
    const service = createService({ EMAIL_DAILY_LIMIT: '1' }, createPrisma(1));

    await expect(
      service.sendNow('recipient@example.com', 'Verify', '<p>Verify</p>'),
    ).rejects.toThrow('EMAIL_DAILY_LIMIT_REACHED: limit=1 sentToday=1');
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('sanitizes provider failure messages before surfacing them', async () => {
    mockResendSend.mockResolvedValue({
      data: null,
      error: {
        name: 'validation_error',
        statusCode: 400,
        message:
          'Invalid reset URL https://app.wiez.me/reset-password?token=secret-token-value for recipient@example.com',
      },
      headers: null,
    });
    const service = createService();

    await expect(
      service.sendNow('recipient@example.com', 'Reset', '<p>Reset</p>'),
    ).rejects.toThrow(
      'validation_error: status=400: Invalid reset URL [url-redacted] for [email-redacted]',
    );
  });
});
