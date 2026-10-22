import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  classifySignupError,
  operationalAlertEvent,
  paymentOutcome,
  signupFailed,
  signupSucceeded,
} from './business-events';
import { renderMessage, safeUrl } from './telegram-message.format';

describe('signup failure classification', () => {
  it.each([
    [new ConflictException({ code: 'EMAIL_ALREADY_EXISTS', message: 'Email already exists' }), false, 'EMAIL_ALREADY_EXISTS'],
    [new BadRequestException('Missing required fields for REGULAR users: firstName'), false, 'BadRequestException'],
    [Object.assign(new Error('Unique constraint'), { code: 'P2002' }), false, 'EMAIL_ALREADY_EXISTS'],
    [new BadRequestException('Failed to create user account'), true, 'BadRequestException'],
    [new BadRequestException('Database connection error'), true, 'BadRequestException'],
    [new BadRequestException('Failed to create user: connection reset'), true, 'BadRequestException'],
    [new Error('socket hang up'), true, 'Error'],
  ])('%p → system=%p', (error, system, code) => {
    const result = classifySignupError(error);
    expect(result.system).toBe(system);
    expect(result.code).toBe(code);
  });

  it('system failures are immediate and carry the email; rejections are threshold-only without identity', () => {
    const system = signupFailed({ error: new BadRequestException('Failed to create user account'), email: 'x@y.com', method: 'Email & password', req: null });
    expect(system.key).toBe('auth.signup_system_failure');
    expect(system.identity?.email).toBe('x@y.com');
    const rejected = signupFailed({ error: new ConflictException('dup'), email: 'x@y.com', method: 'Email & password', req: null });
    expect(rejected.key).toBe('auth.signup_rejected');
    expect(rejected.identity).toBeNull();
  });
});

describe('signupSucceeded', () => {
  it('routes brands and shoppers to different events, keyed by user id', () => {
    const shopper = signupSucceeded({ user: { id: 'u1', type: 'REGULAR' }, method: 'Google', req: { headers: { 'x-client-platform': 'mobile-android' } } });
    expect(shopper.key).toBe('user.registered');
    expect(shopper.idempotencyKey).toBe('u1');
    expect(shopper.fields).toContainEqual(['Platform', 'Mobile app']);
    const brand = signupSucceeded({ user: { id: 'u2', type: 'BRAND' }, method: 'Email & password', req: null, brandName: 'Adire House' });
    expect(brand.key).toBe('brand.registered');
    expect(brand.fields).toContainEqual(['Brand name', 'Adire House']);
  });
});

describe('paymentOutcome', () => {
  it('is idempotent per reference + status and includes the failure reason', () => {
    const event = paymentOutcome(
      {
        id: 'a1',
        reference: 'WIEZ-REF-1',
        status: 'FAILED',
        amount: 15000,
        currency: 'NGN',
        provider: 'PAYSTACK',
        failureCode: 'PAYMENT_FAILED',
        failureMessage: 'Payment provider reported the payment as failed.',
        buyerId: 'buyer-1',
        createdAt: new Date('2026-10-22T10:00:00Z'),
        finalizedAt: new Date('2026-10-22T10:03:00Z'),
      },
      'webhook',
    );
    expect(event.key).toBe('payment.failed');
    expect(event.idempotencyKey).toBe('WIEZ-REF-1:FAILED');
    expect(event.fields).toContainEqual(['Failure reason', 'Payment provider reported the payment as failed.']);
    expect(event.fields).toContainEqual(['Time to outcome', '3m']);
    expect(event.identity?.userId).toBe('buyer-1');
  });
});

describe('operational alert policy', () => {
  const base = { category: 'SYSTEM', severity: 'warning', title: null, message: 'm', emittedAt: '2026-10-22T10:00:00Z' } as any;

  it('5xx → threshold event, 401/403 → counter only', () => {
    expect((operationalAlertEvent({ ...base, event: 'http_unhandled_failure', metadata: { method: 'GET', path: '/x', status: 500 } }, false) as any).key).toBe('http.server_error');
    expect(operationalAlertEvent({ ...base, event: 'http_auth_or_permission_failure' }, false)).toEqual({ countOnly: 'http.auth_failure' });
  });

  it('critical / admin-routed / error-level payment alerts are immediate; others counted', () => {
    expect((operationalAlertEvent({ ...base, event: 'X', severity: 'critical' }, false) as any).key).toBe('operational.alert');
    expect((operationalAlertEvent({ ...base, event: 'PAYMENT_WEBHOOK_INVALID_SIGNATURE' }, true) as any).key).toBe('operational.alert');
    expect((operationalAlertEvent({ ...base, event: 'payment_mismatch', severity: 'error', category: 'PAYMENT' }, false) as any).key).toBe('operational.alert');
    expect(operationalAlertEvent({ ...base, event: 'something_minor' }, false)).toEqual({ countOnly: 'operational.alert:something_minor' });
  });
});

describe('message rendering', () => {
  const message = {
    environment: 'SIT',
    severity: 'info' as const,
    title: 'New user registered',
    identity: { userId: 'aaaaaaaa-bbbb', username: 'ada', email: 'ada@example.com', accountType: 'REGULAR' },
    timeline: [['Account created', new Date('2026-10-22T06:00:00Z')]] as any,
  };

  it('shows username, email and id when identity is enabled', () => {
    const text = renderMessage(message, { includeIdentity: true, timeZone: 'Africa/Lagos' });
    expect(text).toContain('[SIT] New user registered');
    expect(text).toContain('Username: @ada');
    expect(text).toContain('Email: ada@example.com');
    expect(text).toContain('ID: aaaaaaaa-bbbb');
    expect(text).toMatch(/Account created: 22 Oct 2026, 07:00/);
  });

  it('hides personal data when identity is disabled', () => {
    const text = renderMessage(message, { includeIdentity: false, timeZone: 'Africa/Lagos' });
    expect(text).not.toContain('ada@example.com');
    expect(text).not.toContain('@ada');
    expect(text).toContain('aaaaaaaa… (identity hidden by config)');
  });

  it('strips control characters that could spoof layout', () => {
    const text = renderMessage({ ...message, title: 'Hi‮evil\u0007' }, { includeIdentity: false, timeZone: 'UTC' });
    expect(text).not.toMatch(/[‮\u0007]/);
  });

  it.each([
    ['http://sentry.io/x', null],
    ['javascript:alert(1)', null],
    ['https://user:pw@sentry.io/x', null],
    ['https://sentry.io.evil.com/x', null],
    ['https://wiez.sentry.io/issues/1/', 'https://wiez.sentry.io/issues/1/'],
    ['https://weaz.me/admin/monitoring', 'https://weaz.me/admin/monitoring'],
  ])('safeUrl(%s)', (input, expected) => {
    expect(safeUrl(input)).toBe(expected);
  });
});
