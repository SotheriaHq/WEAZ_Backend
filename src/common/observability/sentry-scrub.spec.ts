import type { ErrorEvent, Log } from '@sentry/nestjs';
import {
  redactSensitiveText,
  scrubBreadcrumb,
  scrubEvent,
  scrubLog,
  scrubSpan,
  stripQuery,
} from './sentry-scrub';

const LEAKS = [
  'tok_reset_abc123',
  'sk_live_51HxyzSECRET',
  'AUTH_q8w7e6r5',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVl',
  'ada@example.com',
  'hunter2',
  'deadbeef',
];

function expectNoLeaks(value: unknown) {
  const text = JSON.stringify(value);
  for (const leak of LEAKS) expect(text).not.toContain(leak);
}

describe('sentry scrubbing', () => {
  it('removes recovery credentials in paths across every telemetry channel', () => {
    const token = '123e4567-e89b-12d3-a456-426614174000';
    for (const route of ['checkout-sessions/resume', 'resume']) {
      const url = `https://api.weaz.me/custom-orders/${route}/${token}?view=checkout`;
      const event = scrubEvent({
        request: { url },
        message: `GET ${url}`,
        transaction: `GET /custom-orders/${route}/${token}`,
        exception: { values: [{ value: `Failed ${url}` }] },
        tags: { 'http.path': `/custom-orders/${route}/${token}` },
        extra: { nested: { route: url } },
        contexts: { trace: { description: url } },
        breadcrumbs: [{ message: url, data: { url } }],
        spans: [
          {
            span_id: 'a',
            trace_id: 'b',
            start_timestamp: 0,
            description: url,
            data: { 'http.url': url },
          },
        ],
      } as unknown as ErrorEvent);
      expect(JSON.stringify(event)).not.toContain(token);
      expect(event.request?.url).toBe(
        `https://api.weaz.me/custom-orders/${route}/<token>`,
      );
      expect(
        JSON.stringify(
          scrubLog({
            message: url,
            attributes: { path: url },
          } as unknown as Log),
        ),
      ).not.toContain(token);
      expect(
        stripQuery(
          `/custom-orders/${route}/${encodeURIComponent('secret/segment')}`,
        ),
      ).toBe(`/custom-orders/${route}/<token>`);
    }
    // Ordinary order IDs are useful for diagnosis and are not bearer secrets.
    expect(stripQuery(`/custom-orders/${token}?tab=items`)).toBe(
      `/custom-orders/${token}`,
    );
  });

  it('does not restore credentials when scrubbing URL fields', () => {
    const result = scrubBreadcrumb({
      data: { url: 'https://user:secret@api.weaz.me/orders/1?token=x' },
    });
    expect(result.data?.url).toBe('https://<credentials>@api.weaz.me/orders/1');
  });
  it('removes tokens, keys, codes, signed URLs and emails from free text', () => {
    const text = [
      'Reset failed for https://weaz.me/reset-password?token=tok_reset_abc123',
      'GET https://wiez-media.r2.cloudflarestorage.com/a.jpg?X-Amz-Signature=deadbeef&X-Amz-Credential=key',
      'Paystack said: invalid key sk_live_51HxyzSECRET for AUTH_q8w7e6r5',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVl',
      'user ada@example.com password=hunter2 Authorization: Bearer abc.def',
    ].join('\n');

    const redacted = redactSensitiveText(text);
    expectNoLeaks(redacted);
    // What makes the report useful survives.
    expect(redacted).toContain('https://weaz.me/reset-password?<query>');
    expect(redacted).toContain('<authorization-code>');
    expect(redacted).toContain('<email>');
    expect(
      redactSensitiveText(
        'Order 123e4567-e89b-12d3-a456-426614174000 failed with 409',
      ),
    ).toBe('Order 123e4567-e89b-12d3-a456-426614174000 failed with 409');
  });

  it('keeps the request path but not its query, cookies, body or credentials', () => {
    const event = scrubEvent({
      request: {
        url: 'https://api.weaz.me/auth/app-link/verify-email?token=tok_reset_abc123',
        query_string: 'token=tok_reset_abc123',
        cookies: { refresh_token: 'tok_reset_abc123' },
        data: { password: 'hunter2', email: 'ada@example.com' },
        headers: {
          Authorization:
            'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVl',
          Cookie: 'refresh_token=tok_reset_abc123',
          'User-Agent': 'WIEZ/1.0',
        },
      },
      exception: {
        values: [
          {
            type: 'Error',
            value: 'Paystack: sk_live_51HxyzSECRET rejected AUTH_q8w7e6r5',
          },
        ],
      },
      extra: {
        payload: {
          authorization_code: 'AUTH_q8w7e6r5',
          nested: { password: 'hunter2' },
        },
        note: 'ada@example.com',
      },
      user: { id: 'user-1', email: 'ada@example.com', ip_address: '1.2.3.4' },
      breadcrumbs: [
        {
          category: 'http',
          data: {
            url: 'https://cdn.example/x.jpg?X-Amz-Signature=deadbeef',
            method: 'GET',
          },
        },
      ],
      spans: [
        {
          span_id: 'a',
          trace_id: 'b',
          start_timestamp: 0,
          description:
            'GET https://api.paystack.co/transaction/verify/ref?token=tok_reset_abc123',
          data: {
            'http.url': 'https://api.paystack.co/x?token=tok_reset_abc123',
          },
        },
      ],
    } as unknown as ErrorEvent);

    expectNoLeaks(event);
    expect(event.request?.url).toBe(
      'https://api.weaz.me/auth/app-link/verify-email',
    );
    expect(event.request?.headers).toEqual({ 'User-Agent': 'WIEZ/1.0' });
    expect(event.user).toEqual({ id: 'user-1' });
    expect(event.breadcrumbs?.[0].data?.url).toBe('https://cdn.example/x.jpg');
    expect(event.breadcrumbs?.[0].data?.method).toBe('GET');
  });

  it('scrubs breadcrumbs, spans and logs on their own hooks too', () => {
    expectNoLeaks(
      scrubBreadcrumb({
        message: 'sent to ada@example.com',
        data: { url: 'https://x.test/a?token=tok_reset_abc123' },
      }),
    );
    expectNoLeaks(
      scrubSpan({
        span_id: 'a',
        trace_id: 'b',
        start_timestamp: 0,
        description:
          'POST https://api.paystack.co/charge?key=sk_live_51HxyzSECRET',
        data: {
          'url.full': 'https://api.paystack.co/charge?key=sk_live_51HxyzSECRET',
        },
      } as never),
    );
    expectNoLeaks(
      scrubLog({
        level: 'info',
        message: 'login for ada@example.com with password=hunter2',
        attributes: { token: 'tok_reset_abc123', email: 'ada@example.com' },
      } as unknown as Log),
    );
    expect(stripQuery('/orders/1?tab=open#x')).toBe('/orders/1');
  });

  it('is wired into Sentry.init when a DSN is configured', () => {
    jest.isolateModules(() => {
      const init = jest.fn();
      jest.doMock('@sentry/nestjs', () => ({ init }));
      const previous = process.env.SENTRY_DSN;
      process.env.SENTRY_DSN = 'https://public@o0.ingest.sentry.io/0';
      try {
        const { initSentry } = jest.requireActual('./sentry.instrument');
        initSentry();
        const options = init.mock.calls[0][0];
        for (const hook of [
          'beforeSend',
          'beforeSendTransaction',
          'beforeSendSpan',
          'beforeBreadcrumb',
          'beforeSendLog',
        ]) {
          expect(typeof options[hook]).toBe('function');
        }
        expect(options.sendDefaultPii).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.SENTRY_DSN;
        else process.env.SENTRY_DSN = previous;
      }
    });
  });
});
