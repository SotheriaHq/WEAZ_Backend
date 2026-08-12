import { ConfigService } from '@nestjs/config';

import { TokenService } from './general.helper';

/**
 * The refresh-token pepper: rotation and the refusal to borrow the JWT secret.
 *
 * Both behaviours guard against the same outage — every logged-in user being
 * signed out because a key they never see changed underneath them.
 */
describe('refresh-token HMAC pepper', () => {
  const ORIGINAL_ENV = process.env;

  const buildService = (env: Record<string, string | undefined>) => {
    const config = {
      get: (key: string) => env[key],
    } as unknown as ConfigService;

    return new TokenService(
      {} as never, // JwtService — unused by the hashing paths under test
      {} as never, // PrismaService
      config,
    ) as unknown as {
      hashRefreshSecret: (secret: string) => string;
      verifyRefreshSecret: (
        secret: string,
        storedHash: string,
      ) => Promise<boolean>;
    };
  };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, APP_ENV: undefined, NODE_ENV: 'test' };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('refuses to fall back to JWT_ACCESS_SECRET in a deployed environment', () => {
    process.env.APP_ENV = 'sit';
    const service = buildService({ JWT_ACCESS_SECRET: 'jwt-secret' });

    // Rotating JWT_ACCESS_SECRET is meant to be invisible. If it also peppered
    // refresh hashes, rotation would sign everyone out — so an unset pepper is
    // a configuration error, not a default.
    expect(() => service.hashRefreshSecret('refresh-secret')).toThrow(
      'Authentication configuration error',
    );
  });

  it('still falls back locally, where there is no rotation story', () => {
    const service = buildService({ JWT_ACCESS_SECRET: 'jwt-secret' });
    expect(service.hashRefreshSecret('refresh-secret')).toMatch(/^hmac1:/);
  });

  it('accepts hashes written with the PREVIOUS pepper', async () => {
    const secret = 'refresh-secret';
    const oldHash = buildService({
      REFRESH_TOKEN_HASH_SECRET: 'pepper-v1',
    }).hashRefreshSecret(secret);

    const rotated = buildService({
      REFRESH_TOKEN_HASH_SECRET: 'pepper-v2',
      REFRESH_TOKEN_HASH_SECRET_PREVIOUS: 'pepper-v1',
    });

    await expect(rotated.verifyRefreshSecret(secret, oldHash)).resolves.toBe(
      true,
    );
    // …and writes with the new one, so sessions migrate on next rotation.
    expect(rotated.hashRefreshSecret(secret)).toBe(
      buildService({ REFRESH_TOKEN_HASH_SECRET: 'pepper-v2' }).hashRefreshSecret(
        secret,
      ),
    );
  });

  it('accepts legacy hashes peppered with JWT_ACCESS_SECRET', async () => {
    const secret = 'refresh-secret';
    // Written before a dedicated pepper existed: the JWT secret was the key.
    const legacyHash = buildService({
      JWT_ACCESS_SECRET: 'jwt-secret',
    }).hashRefreshSecret(secret);

    const adopted = buildService({
      REFRESH_TOKEN_HASH_SECRET: 'pepper-v1',
      JWT_ACCESS_SECRET: 'jwt-secret',
    });

    // Adopting a real pepper must not itself be the mass-logout event.
    await expect(adopted.verifyRefreshSecret(secret, legacyHash)).resolves.toBe(
      true,
    );
  });

  it('rejects a hash from an unrelated key', async () => {
    const secret = 'refresh-secret';
    const foreignHash = buildService({
      REFRESH_TOKEN_HASH_SECRET: 'someone-elses-pepper',
    }).hashRefreshSecret(secret);

    const service = buildService({
      REFRESH_TOKEN_HASH_SECRET: 'pepper-v1',
      REFRESH_TOKEN_HASH_SECRET_PREVIOUS: 'pepper-v0',
      JWT_ACCESS_SECRET: 'jwt-secret',
    });

    await expect(service.verifyRefreshSecret(secret, foreignHash)).resolves.toBe(
      false,
    );
  });
});
