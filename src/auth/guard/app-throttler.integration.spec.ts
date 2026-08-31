import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerModule } from '@nestjs/throttler';
import * as jwt from 'jsonwebtoken';
import * as request from 'supertest';
import { AppThrottlerGuard } from './app-throttler.guard';

/**
 * End-to-end proof, over a real HTTP server.
 *
 * The unit suite reaches `getTracker` directly, which proves the logic but not
 * the wiring — and the wiring is where this bug lived. A guard whose identity
 * branch is unreachable passes every unit test written against the branch. So
 * this suite boots an actual Nest application with the guard bound the way the
 * real app binds it (`APP_GUARD`), sends real requests through it, and asserts
 * on 200/429 rather than on returned strings.
 *
 * It also pins the two things that must NOT change: endpoint-level `@Throttle`
 * overrides still win, and a stricter override is still strict.
 */

const SECRET = 'integration-access-secret';
process.env.JWT_ACCESS_SECRET = SECRET;
process.env.APP_ENV = 'sit'; // shouldEnforceThrottling() must be ON for this suite

const tokenFor = (sub: string, secret = SECRET) =>
  jwt.sign({ sub, username: sub, role: 'User' }, secret, { expiresIn: '10m' });

@Controller('probe')
class ProbeController {
  /** Inherits the module default (3/min in this suite). */
  @Get('default')
  def() {
    return { ok: true };
  }

  /** A stricter endpoint-specific override, mirroring the real auth routes. */
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  @Get('strict')
  strict() {
    return { ok: true };
  }

  /** A looser override, mirroring the real SEO/sitemap routes. */
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Get('loose')
  loose() {
    return { ok: true };
  }
}

describe('AppThrottlerGuard (integration, real HTTP)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 3 }]),
      ],
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirrors production: Express resolves the client IP, the guard never
    // reads a forwarded header itself.
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const hit = (path: string, headers: Record<string, string> = {}) =>
    request(app.getHttpServer()).get(path).set(headers);

  /** Drains a tracker's quota and returns the status of the request after it. */
  const exhaust = async (path: string, times: number, headers = {}) => {
    for (let i = 0; i < times; i += 1) await hit(path, headers);
    return (await hit(path, headers)).status;
  };

  it('boots with the guard wired through DI', () => {
    // If ConfigService injection were wrong, the module would not have compiled.
    expect(app).toBeDefined();
  });

  it('throttles an anonymous caller at the module default', async () => {
    await expect(exhaust('/probe/default', 3)).resolves.toBe(429);
  });

  it('respects a STRICTER endpoint-specific @Throttle override', async () => {
    // Two allowed, third rejected — the override wins over the default of 3.
    const first = await hit('/probe/strict');
    const second = await hit('/probe/strict');
    const third = await hit('/probe/strict');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it('respects a LOOSER endpoint-specific @Throttle override', async () => {
    // Would already be throttled at the default of 3; the override permits 8.
    for (let i = 0; i < 8; i += 1) {
      expect((await hit('/probe/loose')).status).toBe(200);
    }
    expect((await hit('/probe/loose')).status).toBe(429);
  });

  it('gives two authenticated users SEPARATE quotas on the same IP', async () => {
    // The CGNAT case, end to end. Both requests arrive from the same socket.
    const alice = { authorization: `Bearer ${tokenFor('alice')}` };
    const bob = { authorization: `Bearer ${tokenFor('bob')}` };

    await expect(exhaust('/probe/default', 3, alice)).resolves.toBe(429);

    // Bob shares Alice's IP and must be untouched by her exhausted quota.
    expect((await hit('/probe/default', bob)).status).toBe(200);
  });

  it('keeps one authenticated user on ONE quota across forged IP headers', async () => {
    const carol = { authorization: `Bearer ${tokenFor('carol')}` };
    await expect(exhaust('/probe/default', 3, carol)).resolves.toBe(429);

    // Changing every IP-ish header must not mint a fresh bucket for carol.
    const spoofed = await hit('/probe/default', {
      ...carol,
      'x-forwarded-for': '9.9.9.9, 8.8.8.8',
      'cf-connecting-ip': '7.7.7.7',
      'true-client-ip': '6.6.6.6',
      'x-real-ip': '5.5.5.5',
    });
    expect(spoofed.status).toBe(429);
  });

  it('does not let a FORGED token buy a fresh quota', async () => {
    // Exhaust the anonymous bucket, then present an unverifiable token. It must
    // be ignored, leaving the caller on the same exhausted IP bucket.
    await exhaust('/probe/default', 3);

    const forged = { authorization: `Bearer ${tokenFor('mallory', 'wrong-secret')}` };
    expect((await hit('/probe/default', forged)).status).toBe(429);

    const alg = jwt.sign({ sub: 'mallory' }, '', { algorithm: 'none' });
    expect(
      (await hit('/probe/default', { authorization: `Bearer ${alg}` })).status,
    ).toBe(429);
  });

  it('sends rate-limit headers a client can act on', async () => {
    const res = await hit('/probe/loose', {
      authorization: `Bearer ${tokenFor('headers-user')}`,
    });
    expect(res.headers['x-ratelimit-limit']).toBe('8');
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });
});
