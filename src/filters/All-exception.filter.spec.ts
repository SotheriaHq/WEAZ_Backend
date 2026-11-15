import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './All-exception.filter';

describe('AllExceptionsFilter', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    jest.restoreAllMocks();
  });

  const createHost = () => {
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const request = {
      method: 'POST',
      url: '/auth/login?token=raw-token',
      path: '/auth/login',
    };
    return {
      response,
      host: {
        switchToHttp: () => ({
          getResponse: () => response,
          getRequest: () => request,
        }),
      } as any,
    };
  };

  it('forwards the step-up challenge fields clients need on a 428 security challenge', () => {
    const filter = new AllExceptionsFilter();
    const { host, response } = createHost();
    const expiresAt = new Date('2026-11-12T10:05:00.000Z');
    filter.catch(
      new HttpException(
        {
          code: 'STEP_UP_REQUIRED',
          message:
            'Verify this action with your authenticator app, passkey or recovery code.',
          action: 'store.payment_account.update',
          challengeId: '7f6a3f53-8f4e-4b8a-9d55-0f0b7c1c2a11',
          expiresAt,
          sensitivity: 'CRITICAL_CHANGE',
          serverNow: '2026-11-12T10:00:00.000Z',
          review: { title: 'Change payout account' },
          internalNote: 'must never reach the client',
        },
        428,
      ),
      host,
    );
    expect(response.status).toHaveBeenCalledWith(428);
    const body = response.json.mock.calls[0][0];
    expect(body).toMatchObject({
      statusCode: 428,
      code: 'STEP_UP_REQUIRED',
      action: 'store.payment_account.update',
      challengeId: '7f6a3f53-8f4e-4b8a-9d55-0f0b7c1c2a11',
      expiresAt,
      sensitivity: 'CRITICAL_CHANGE',
      serverNow: '2026-11-12T10:00:00.000Z',
      review: { title: 'Change payout account' },
    });
    expect(body).not.toHaveProperty('internalNote');
  });

  it('keeps every other error shape unchanged (no challenge fields outside 428 security codes)', () => {
    const filter = new AllExceptionsFilter();
    const first = createHost();
    filter.catch(
      new BadRequestException({ message: 'Bad', challengeId: 'x' }),
      first.host,
    );
    expect(first.response.json.mock.calls[0][0]).not.toHaveProperty(
      'challengeId',
    );
    const second = createHost();
    filter.catch(
      new HttpException({ code: 'SOMETHING_ELSE', challengeId: 'x' }, 428),
      second.host,
    );
    expect(second.response.json.mock.calls[0][0]).not.toHaveProperty(
      'challengeId',
    );
  });

  it('redacts sensitive validation values and removes query strings', () => {
    const filter = new AllExceptionsFilter();
    const { host, response } = createHost();

    filter.catch(
      new BadRequestException({
        message: 'Validation failed',
        errors: [{ property: 'password', value: 'RawPassword123!' }],
      }),
      host,
    );

    const payload = response.json.mock.calls[0][0];
    expect(payload.path).toBe('/auth/login');
    expect(JSON.stringify(payload)).not.toContain('RawPassword123!');
    expect(payload.errors[0].value).toBe('[REDACTED]');
  });

  it('does not expose stack traces or internal 500 details in production', () => {
    process.env.NODE_ENV = 'production';
    const filter = new AllExceptionsFilter();
    const loggerSpy = jest.spyOn((filter as any).logger, 'error');
    const { host, response } = createHost();

    filter.catch(
      new InternalServerErrorException('database stack secret'),
      host,
    );

    const payload = response.json.mock.calls[0][0];
    expect(JSON.stringify(payload)).not.toContain('database stack secret');
    expect(JSON.stringify(payload)).not.toContain('stack');
    expect(loggerSpy.mock.calls[0][1]).toBeUndefined();
  });

  it('emits safe security monitoring for forbidden responses', () => {
    const monitoring = { emitAlert: jest.fn() };
    const filter = new AllExceptionsFilter(monitoring as any);
    const { host } = createHost();

    filter.catch(new ForbiddenException('missing permission'), host);

    expect(monitoring.emitAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'SECURITY',
        severity: 'warning',
        event: 'http_auth_or_permission_failure',
        metadata: expect.objectContaining({
          status: 403,
          method: 'POST',
          path: '/auth/login',
        }),
      }),
    );
    expect(JSON.stringify(monitoring.emitAlert.mock.calls)).not.toContain(
      'raw-token',
    );
  });
});
