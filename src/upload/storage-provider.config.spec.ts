import { createHmac } from 'node:crypto';
import {
  encodeMediaObjectKey,
  isRawStorageUrl,
  resolveStorageProviderSettings,
  signPublicGatewayUrl,
  StorageConfigReader,
  storageObjectUrl,
} from './storage-provider.config';

const account = '0123456789abcdef0123456789abcdef';
const secret = 'a-local-test-secret-that-is-at-least-32-bytes';
const read = (values: Record<string, unknown>): StorageConfigReader => ({
  get: <T>(key: string) => values[key] as T | undefined,
});
const r2 = () => ({
  STORAGE_PROVIDER: 'R2',
  R2_BUCKET: 'wiez-sit-media',
  R2_ACCOUNT_ID: account,
  R2_ACCESS_KEY_ID: 'r2-test-access',
  R2_SECRET_ACCESS_KEY: 'r2-test-secret',
});
const gateway = () => ({
  MEDIA_GATEWAY_BASE_URL: 'https://media.example.test/media',
  MEDIA_GATEWAY_SECRET: secret,
  MEDIA_GATEWAY_ENVIRONMENT: 'sit',
});

describe('storage provider configuration boundaries', () => {
  it('uses only R2 when the provider selector is omitted', () => {
    expect(
      resolveStorageProviderSettings(
        read({ ...r2(), STORAGE_PROVIDER: undefined }),
      ).provider,
    ).toBe('R2');
  });

  it.each(['S3', 'unknown'])(
    'refuses the retired/unknown provider %s',
    (provider) => {
      expect(() =>
        resolveStorageProviderSettings(
          read({ ...r2(), STORAGE_PROVIDER: provider }),
        ),
      ).toThrow('Only R2 storage is supported');
    },
  );

  it.each(['AWS_S3_BUCKET', 'S3_BUCKET', 'S3_ENDPOINT'])(
    'rejects retired storage configuration %s',
    (name) => {
      expect(() =>
        resolveStorageProviderSettings(read({ ...r2(), [name]: 'retired' })),
      ).toThrow(`${name} is retired`);
    },
  );

  it('does not construct an IAM-backed client when no R2 configuration exists', () => {
    expect(() =>
      resolveStorageProviderSettings(
        read({
          AWS_ACCESS_KEY_ID: 'unrelated-access',
          AWS_SECRET_ACCESS_KEY: 'unrelated-secret',
        }),
      ),
    ).toThrow('R2_BUCKET is required');
  });

  it('uses R2-only credentials and region even when unrelated AWS/SES settings exist', () => {
    const settings = resolveStorageProviderSettings(
      read({
        ...r2(),
        AWS_REGION: 'af-south-1',
        AWS_ACCESS_KEY_ID: 'ses-only',
        AWS_SECRET_ACCESS_KEY: 'ses-secret',
      }),
    );
    expect(settings).toEqual({
      provider: 'R2',
      bucket: 'wiez-sit-media',
      region: 'auto',
      endpoint: `https://${account}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: 'r2-test-access',
        secretAccessKey: 'r2-test-secret',
      },
    });
  });

  it.each(['R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'])(
    'cannot fall back to AWS when %s is missing',
    (name) => {
      const values: Record<string, unknown> = {
        ...r2(),
        AWS_ACCESS_KEY_ID: 'old-access',
        AWS_SECRET_ACCESS_KEY: 'old-secret',
      };
      delete values[name];
      expect(() => resolveStorageProviderSettings(read(values))).toThrow(
        `${name} is required`,
      );
    },
  );

  it.each(['eu', 'us', 'fedramp'])(
    'accepts a validated %s jurisdiction endpoint without a duplicate account setting',
    (jurisdiction) => {
      const values = {
        ...r2(),
        R2_ACCOUNT_ID: undefined,
        R2_ENDPOINT: `https://${account}.${jurisdiction}.r2.cloudflarestorage.com`,
      };
      expect(resolveStorageProviderSettings(read(values)).endpoint).toBe(
        values.R2_ENDPOINT,
      );
    },
  );

  it.each([
    `http://${account}.r2.cloudflarestorage.com`,
    `https://${account}.r2.cloudflarestorage.com/bucket`,
    `https://${account}.r2.cloudflarestorage.com?credential=secret`,
    `https://${account}.r2.cloudflarestorage.com.attacker.test`,
    'https://wrong.example.test',
    'https://ffffffffffffffffffffffffffffffff.r2.cloudflarestorage.com',
  ])('rejects a partial or misleading R2 endpoint (%s)', (endpoint) => {
    expect(() =>
      resolveStorageProviderSettings(read({ ...r2(), R2_ENDPOINT: endpoint })),
    ).toThrow('R2_ENDPOINT');
  });

  it.each(['MEDIA_BUCKET_PUBLIC', 'S3_PUBLIC_READ', 'R2_BUCKET_PUBLIC'])(
    'requires private R2 objects even with a gateway: %s',
    (flag) => {
      expect(() =>
        resolveStorageProviderSettings(
          read({ ...r2(), ...gateway(), [flag]: 'true' }),
        ),
      ).toThrow('private R2 storage');
    },
  );

  it('rejects raw public bases and mismatched legacy CDN origins in R2 mode', () => {
    expect(() =>
      resolveStorageProviderSettings(
        read({ ...r2(), MEDIA_PUBLIC_BASE_URL: 'https://public.example.test' }),
      ),
    ).toThrow('MEDIA_PUBLIC_BASE_URL');
    expect(() =>
      resolveStorageProviderSettings(
        read({
          ...r2(),
          ...gateway(),
          S3_PUBLIC_BASE_URL: 'https://other.example.test',
        }),
      ),
    ).toThrow('S3_PUBLIC_BASE_URL');
    expect(() =>
      resolveStorageProviderSettings(
        read({
          ...r2(),
          ...gateway(),
          MEDIA_PUBLIC_BASE_URL: gateway().MEDIA_GATEWAY_BASE_URL,
        }),
      ),
    ).toThrow('is retired');
  });

  it('accepts the minimum gateway lifetime above the client refresh margin', () => {
    expect(
      resolveStorageProviderSettings(
        read({ ...r2(), ...gateway(), MEDIA_GATEWAY_TTL_SECONDS: '60' }),
      ).publicGateway?.ttlSeconds,
    ).toBe(60);
  });

  it.each([
    `https://${account}.r2.cloudflarestorage.com`,
    'https://pub-secret.r2.dev',
    'https://bucket.s3.us-east-1.amazonaws.com',
  ])(
    'cannot label a raw storage host as an authenticated gateway: %s',
    (base) => {
      expect(() =>
        resolveStorageProviderSettings(
          read({ ...r2(), ...gateway(), MEDIA_GATEWAY_BASE_URL: base }),
        ),
      ).toThrow('authenticated Worker');
    },
  );

  it.each([
    { MEDIA_GATEWAY_SECRET: undefined },
    { MEDIA_GATEWAY_ENVIRONMENT: undefined },
    { MEDIA_GATEWAY_SECRET: 'short' },
    { MEDIA_GATEWAY_ENVIRONMENT: 'prod\nother' },
    { MEDIA_GATEWAY_TTL_SECONDS: '901' },
    { MEDIA_GATEWAY_TTL_SECONDS: '0' },
    { MEDIA_GATEWAY_TTL_SECONDS: '1' },
    { MEDIA_GATEWAY_TTL_SECONDS: '59' },
    { MEDIA_GATEWAY_TTL_SECONDS: '10.5' },
    { MEDIA_GATEWAY_TTL_SECONDS: 'Infinity' },
    { MEDIA_GATEWAY_BASE_URL: 'https://media.example.test/path%2Fprefix' },
  ])('rejects incomplete or unsafe gateway configuration: %j', (override) => {
    expect(() =>
      resolveStorageProviderSettings(
        read({ ...r2(), ...gateway(), ...override }),
      ),
    ).toThrow('MEDIA_GATEWAY');
  });

  it('classifies only storage origins, never lookalike external hostnames', () => {
    const settings = resolveStorageProviderSettings(read(r2()));
    expect(
      isRawStorageUrl(
        settings,
        `https://${account}.r2.cloudflarestorage.com/wiez-sit-media/file`,
      ),
    ).toBe(true);
    expect(isRawStorageUrl(settings, 'https://pub-example.r2.dev/file')).toBe(
      true,
    );
    expect(
      isRawStorageUrl(
        settings,
        'https://bucket.s3.eu-north-1.amazonaws.com/file',
      ),
    ).toBe(true);
    expect(
      isRawStorageUrl(settings, 'https://amazonaws.com.attacker.test/file'),
    ).toBe(false);
    expect(isRawStorageUrl(settings, 'https://media.example.test/file')).toBe(
      false,
    );
    expect(isRawStorageUrl(settings, 'not a URL')).toBe(false);
  });

  it('uses the R2 API only as metadata identity, without generating an AWS URL', () => {
    const settings = resolveStorageProviderSettings(read(r2()));
    expect(storageObjectUrl(settings, 'POST_IMAGE/user/Adiré 100%.jpg')).toBe(
      `https://${account}.r2.cloudflarestorage.com/wiez-sit-media/POST_IMAGE/user/Adir%C3%A9%20100%25.jpg`,
    );
  });

  it('signs the gateway audience/path/key/environment rather than rewriting an SDK signature', () => {
    const settings = resolveStorageProviderSettings(
      read({ ...r2(), ...gateway() }),
    );
    const key = 'POST_IMAGE/user/Adiré 100%.jpg';
    const url = new URL(
      signPublicGatewayUrl(
        settings.publicGateway!,
        key,
        'GET',
        1_800_000_000_000,
      ),
    );
    expect(url.origin).toBe('https://media.example.test');
    expect(url.pathname).toBe('/media/POST_IMAGE/user/Adir%C3%A9%20100%25.jpg');
    expect(url.searchParams.get('exp')).toBe('1800000300');
    expect(url.searchParams.has('X-Amz-Signature')).toBe(false);
    const canonical = [
      'WIEZ-MEDIA-V1',
      'GET',
      url.origin,
      url.pathname,
      key,
      'sit',
      '1800000300',
    ].join('\n');
    expect(url.searchParams.get('sig')).toBe(
      createHmac('sha256', secret).update(canonical).digest('base64url'),
    );
  });

  it.each([
    '../secret',
    'folder/../secret',
    '/secret',
    'folder//file',
    'folder\\file',
    'folder/file\nsecret',
    'a'.repeat(1025),
  ])('rejects unsafe or oversized object keys', (key) => {
    expect(() => encodeMediaObjectKey(key)).toThrow('Invalid media object key');
  });
});
