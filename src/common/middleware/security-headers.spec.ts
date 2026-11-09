import { createServer, get, type IncomingHttpHeaders, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { EventsGateway } from 'src/realtime/events.gateway';
import { TokenService } from 'src/auth/helper/general.helper';
import {
  isHttpsRequest,
  REALTIME_CONTENT_SECURITY_POLICY,
  securityHeadersFor,
  STRICT_TRANSPORT_SECURITY,
} from './security-headers';

/*
 * Findings from the ZAP scan of SIT (2026-11) this pins shut:
 *  - /socket.io/ responses had no X-Frame-Options, X-Content-Type-Options,
 *    HSTS or CSP, because Engine.IO answers before Express middleware runs;
 *  - the accessToken/refreshToken cookies had no Secure flag over HTTPS,
 *    because Secure keyed on NODE_ENV=production and SIT is not "production".
 */

describe('isHttpsRequest', () => {
  it.each([
    ['Express secure flag', { headers: {}, secure: true }, true],
    ['direct TLS socket', { headers: {}, socket: { encrypted: true } }, true],
    ['TLS proxy in front', { headers: { 'x-forwarded-proto': 'https' } }, true],
    ['proxy chain, client hop first', { headers: { 'x-forwarded-proto': 'HTTPS, http' } }, true],
    ['plain http', { headers: { 'x-forwarded-proto': 'http' } }, false],
    ['no signal at all', { headers: {} }, false],
  ])('%s', (_label, req, expected) => {
    expect(isHttpsRequest(req as never)).toBe(expected);
  });

  it('treats a missing request as not secure', () => {
    expect(isHttpsRequest(undefined)).toBe(false);
  });
});

describe('securityHeadersFor', () => {
  it('always sends the anti-framing and anti-sniffing set', () => {
    const headers = securityHeadersFor({ headers: {} });
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Strict-Transport-Security']).toBeUndefined();
    expect(headers['Content-Security-Policy']).toBeUndefined();
  });

  it('adds HSTS only over HTTPS, and CSP only when asked', () => {
    const headers = securityHeadersFor(
      { headers: { 'x-forwarded-proto': 'https' } },
      { contentSecurityPolicy: REALTIME_CONTENT_SECURITY_POLICY },
    );
    expect(headers['Strict-Transport-Security']).toBe(STRICT_TRANSPORT_SECURITY);
    expect(headers['Content-Security-Policy']).toBe(REALTIME_CONTENT_SECURITY_POLICY);
  });
});

describe('Socket.IO transport responses', () => {
  let http: HttpServer;
  let io: Server;
  let port: number;

  beforeAll(async () => {
    http = createServer();
    io = new Server(http);
    // The real gateway hook, on a real Engine.IO server.
    new EventsGateway({} as never, {} as never).afterInit(io);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    port = (http.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });

  const handshake = (headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
      const req = get(
        { host: '127.0.0.1', port, path: '/socket.io/?EIO=4&transport=polling', headers },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        },
      );
      req.on('error', reject);
    });

  it('carries the security headers on the polling handshake', async () => {
    const res = await handshake();
    expect(res.status).toBe(200);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe(REALTIME_CONTENT_SECURITY_POLICY);
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('adds HSTS when the TLS proxy says the client used HTTPS', async () => {
    const res = await handshake({ 'X-Forwarded-Proto': 'https' });
    expect(res.headers['strict-transport-security']).toBe(STRICT_TRANSPORT_SECURITY);
  });
});

describe('session cookies', () => {
  type CookieCall = { name: string; options: { secure?: boolean } };

  const attach = (env: Record<string, string>, reqHeaders: Record<string, string>) => {
    const service = Object.create(TokenService.prototype) as {
      configService: { get: (key: string, fallback?: unknown) => unknown };
      attachAuthCookies: (res: unknown, a: string, r: string, ttl: number) => void;
    };
    service.configService = { get: (key, fallback) => env[key] ?? fallback };
    const calls: CookieCall[] = [];
    const res = {
      req: { headers: reqHeaders },
      cookie: (name: string, _value: string, options: CookieCall['options']) =>
        calls.push({ name, options }),
    };
    service.attachAuthCookies(res, 'access', 'refresh', 60_000);
    return calls;
  };

  it('are Secure over HTTPS even when NODE_ENV is not production (SIT)', () => {
    const calls = attach({ NODE_ENV: 'sit' }, { 'x-forwarded-proto': 'https' });
    expect(calls.map((c) => c.name).sort()).toEqual(['accessToken', 'refreshToken']);
    expect(calls.every((c) => c.options.secure === true)).toBe(true);
  });

  it('stay usable on plain-http localhost', () => {
    const calls = attach({ NODE_ENV: 'development' }, {});
    expect(calls.every((c) => c.options.secure === false)).toBe(true);
  });

  it('are always Secure in production', () => {
    const calls = attach({ NODE_ENV: 'production' }, {});
    expect(calls.every((c) => c.options.secure === true)).toBe(true);
  });
});
