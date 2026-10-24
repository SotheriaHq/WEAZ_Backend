import { createHmac } from 'crypto';
import {
  endpointPath,
  parseSentryWebhook,
  scrubSentryText,
  sentrySeverity,
  verifySentrySignature,
} from './sentry-alert.parser';

const SECRET = 'client-secret-for-tests';

const eventAlertBody = {
  action: 'triggered',
  data: {
    triggered_rule: 'New SIT issue',
    event: {
      event_id: 'abc123',
      issue_id: '6123456789',
      title: "TypeError: Cannot read properties of undefined (reading 'id')",
      level: 'fatal',
      culprit: 'AuthService.CreateUser',
      environment: 'sit',
      project: 4500000000,
      release: 'v2026.10.22-0001',
      datetime: '2026-10-22T10:00:00Z',
      web_url: 'https://wiez.sentry.io/issues/6123456789/events/abc123/',
      request: {
        method: 'post',
        url: 'https://api.weaz.me/auth/signup?token=SECRETTOKEN&email=a@b.com',
        headers: [['Cookie', 'session=very-secret']],
        cookies: 'session=very-secret',
        data: { password: 'hunter2' },
      },
      tags: [
        ['http.status_code', '500'],
        ['requestId', 'req-42'],
      ],
      user: {
        id: 'user-uuid-1',
        email: 'person@example.com',
        ip_address: '1.2.3.4',
      },
      contexts: {
        runtime: { name: 'node', version: 'v22.19.0' },
        os: { name: 'Linux' },
      },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: "Cannot read 'id' for person@example.com with token=abcdef",
            mechanism: { type: 'onunhandledrejection', handled: false },
            stacktrace: {
              frames: [
                {
                  filename: 'node:internal/process',
                  function: 'tick',
                  in_app: false,
                },
                {
                  filename: 'src/auth/auth.service.ts',
                  function: 'AuthService.CreateUser',
                  lineno: 612,
                  in_app: true,
                },
                {
                  filename: 'node_modules/@prisma/client/runtime.js',
                  function: 'request',
                  in_app: false,
                },
              ],
            },
          },
        ],
      },
      breadcrumbs: { values: [{ message: 'SELECT * FROM users' }] },
    },
  },
};

describe('verifySentrySignature', () => {
  const raw = JSON.stringify(eventAlertBody);
  const sign = (body: string) =>
    createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');

  it('accepts a correct HMAC of the raw body', () => {
    expect(
      verifySentrySignature({
        secret: SECRET,
        signature: sign(raw),
        rawBody: raw,
        parsedBody: eventAlertBody,
      }),
    ).toBe(true);
  });

  it('accepts the JSON.stringify form Sentry documents', () => {
    const spaced = JSON.stringify(eventAlertBody, null, 2);
    expect(
      verifySentrySignature({
        secret: SECRET,
        signature: sign(JSON.stringify(eventAlertBody)),
        rawBody: spaced,
        parsedBody: eventAlertBody,
      }),
    ).toBe(true);
  });

  it.each([
    ['wrong secret', createHmac('sha256', 'other').update(raw).digest('hex')],
    ['tampered body', sign(raw + ' ')],
    ['missing', undefined],
    ['not hex', 'z'.repeat(64)],
    ['short', 'abcd'],
  ])('rejects %s', (_label, signature) => {
    expect(
      verifySentrySignature({
        secret: SECRET,
        signature: signature as any,
        rawBody: raw,
        parsedBody: { other: true },
      }),
    ).toBe(false);
  });

  it('rejects everything when no secret is configured', () => {
    expect(
      verifySentrySignature({
        secret: '',
        signature: sign(raw),
        rawBody: raw,
        parsedBody: eventAlertBody,
      }),
    ).toBe(false);
  });
});

describe('verifySentrySignature with Sentry-style (Python json.dumps) bodies', () => {
  // Sentry sends `{"a": 1, "b": [1, 2]}` — spaces after separators.
  const pythonBody =
    '{"action": "triggered", "data": {"event": {"level": "error", "tags": [["a", "b"]]}}}';
  const signature = createHmac('sha256', SECRET)
    .update(pythonBody, 'utf8')
    .digest('hex');

  it('verifies when the raw bytes are available', () => {
    expect(
      verifySentrySignature({
        secret: SECRET,
        signature,
        rawBody: pythonBody,
        parsedBody: JSON.parse(pythonBody),
      }),
    ).toBe(true);
  });

  it('cannot verify from the parsed body alone (the raw body must be captured for /webhooks/sentry)', () => {
    expect(
      verifySentrySignature({
        secret: SECRET,
        signature,
        rawBody: undefined,
        parsedBody: JSON.parse(pythonBody),
      }),
    ).toBe(false);
  });
});

describe('parseSentryWebhook(event_alert)', () => {
  const alert = parseSentryWebhook('event_alert', eventAlertBody)!;

  it('keeps triage details: endpoint, method, status, request id, frame, type, ids', () => {
    expect(alert.level).toBe('fatal');
    expect(alert.environment).toBe('sit');
    expect(alert.issueId).toBe('6123456789');
    expect(alert.ruleName).toBe('New SIT issue');
    expect(alert.details).toMatchObject({
      eventId: 'abc123',
      method: 'POST',
      endpoint: 'api.weaz.me/auth/signup',
      statusCode: '500',
      requestId: 'req-42',
      errorType: 'TypeError',
      handled: 'no (unhandled)',
      inAppFrame: 'src/auth/auth.service.ts:612 in AuthService.CreateUser',
      runtime: 'node v22.19.0',
      userId: 'user-uuid-1',
    });
  });

  it('drops query strings, cookies, headers, bodies, breadcrumbs, user email/ip and frames', () => {
    const serialized = JSON.stringify(alert);
    for (const secret of [
      'SECRETTOKEN',
      'very-secret',
      'hunter2',
      'SELECT *',
      'person@example.com',
      '1.2.3.4',
      'node_modules',
      'token=abcdef',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(alert.details?.errorMessage).toContain('<email>');
  });

  it('keeps only safe https links', () => {
    expect(alert.webUrl).toBe(
      'https://wiez.sentry.io/issues/6123456789/events/abc123/',
    );
    const evil = parseSentryWebhook('event_alert', {
      data: {
        event: {
          ...eventAlertBody.data.event,
          web_url: 'https://evil.example/phish',
        },
      },
    })!;
    expect(evil.webUrl).toBeNull();
  });
});

describe('parseSentryWebhook(other resources)', () => {
  it('maps metric alert actions to levels', () => {
    const alert = parseSentryWebhook('metric_alert', {
      action: 'critical',
      data: {
        metric_alert: {
          id: '77',
          alert_rule: {
            name: 'Error spike',
            environment: 'sit',
            projects: ['node-nestjs'],
          },
        },
        description_title: 'Critical: Error spike',
        description_text: '120 events in the last 10 minutes',
        web_url: 'https://wiez.sentry.io/alerts/rules/details/77/',
      },
    })!;
    expect(alert.level).toBe('fatal');
    expect(alert.environment).toBe('sit');
    expect(alert.description).toBe('120 events in the last 10 minutes');
    expect(sentrySeverity(alert.level)).toBe('critical');
  });

  it('issue webhooks carry no environment, so they cannot be attributed to SIT', () => {
    const alert = parseSentryWebhook('issue', {
      action: 'created',
      data: { issue: { id: '1', title: 'x' } },
    })!;
    expect(alert.environment).toBeNull();
  });

  it('ignores unknown resources', () => {
    expect(
      parseSentryWebhook('installation', { action: 'created' }),
    ).toBeNull();
  });
});

describe('scrubbing helpers', () => {
  it('endpointPath strips query and fragment', () => {
    expect(endpointPath('https://api.weaz.me/a/b?x=1#y')).toBe(
      'api.weaz.me/a/b',
    );
    expect(endpointPath('/orders/123?token=1')).toBe('/orders/123');
  });

  it('scrubSentryText redacts emails, credentials and long tokens', () => {
    const text = scrubSentryText(
      'failed for a.b@c.io password=hunter2 postgres://u:p@db/x ' +
        'x'.repeat(48),
    )!;
    expect(text).not.toContain('a.b@c.io');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('u:p@');
    expect(text).not.toContain('x'.repeat(48));
  });
});
