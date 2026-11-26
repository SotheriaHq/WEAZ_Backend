import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { MarketCatalogReadService } from './market-catalog-read.service';
import {
  MarketPublicMediaGrant,
  MarketPublicMediaPlan,
  MarketPublicMediaService,
  MARKET_PUBLIC_MEDIA_MAX_FILES,
} from './market-public-media.service';
import {
  MarketMediaAuthorityRow,
  MarketMediaCandidates,
  MarketMediaFileRow,
  MarketMediaVariantRow,
} from './market-public-media.sql';

const first = '00000000-0000-0000-0000-000000000001';
const second = '00000000-0000-0000-0000-000000000002';
const third = '00000000-0000-0000-0000-000000000003';
const product = '00000000-0000-0000-0000-00000000000a';
const otherProduct = '00000000-0000-0000-0000-00000000000b';
const owner = '00000000-0000-0000-0000-00000000000c';
const asOf = new Date('2026-11-21T12:00:00.000Z');
const gatewayConfig = () => ({
  STORAGE_PROVIDER: 'R2',
  R2_BUCKET: 'catalogue-test-media',
  R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  R2_ACCESS_KEY_ID: 'test-only-access',
  R2_SECRET_ACCESS_KEY: 'test-only-secret',
  MEDIA_GATEWAY_BASE_URL: 'https://media.example.test/media',
  MEDIA_GATEWAY_SECRET: 'test-gateway-secret-at-least-thirty-two-bytes',
  MEDIA_GATEWAY_ENVIRONMENT: 'test',
  MEDIA_GATEWAY_TTL_SECONDS: '300',
});
const noGateway = {
  MEDIA_GATEWAY_BASE_URL: undefined,
  MEDIA_GATEWAY_SECRET: undefined,
  MEDIA_GATEWAY_ENVIRONMENT: undefined,
  MEDIA_GATEWAY_TTL_SECONDS: undefined,
};
function fixture(
  row: Partial<MarketMediaAuthorityRow> = {},
  overrides: Record<string, string | undefined> = {},
) {
  let inside = false;
  const query = jest.fn().mockImplementation(async () => {
    expect(inside).toBe(true);
    return [{ guard: [], files: [], variants: [], ...row }];
  });
  // One autocommit statement: the whole authorization is a single read.
  const run = jest
    .fn()
    .mockImplementation(async (sql: Prisma.Sql, options: unknown) => {
      expect(inside).toBe(false);
      inside = true;
      try {
        return await query(sql, options);
      } finally {
        inside = false;
      }
    });
  const values: Record<string, string | undefined> = {
    ...gatewayConfig(),
    ...overrides,
  };
  const configRead = jest.fn((key: string) => {
    // Config access starts the pure gateway-signing phase after the bounded
    // callback has returned; no database connection remains held for HMAC.
    expect(inside).toBe(false);
    return values[key];
  });
  const service = new MarketPublicMediaService(
    { statement: run } as unknown as MarketCatalogReadService,
    { get: configRead } as unknown as ConfigService,
  );
  return { service, run, query, configRead };
}
const file = (
  id = first,
  overrides: Partial<MarketMediaFileRow> = {},
): MarketMediaFileRow => ({
  id,
  s3Key: 'products/approved original.webp',
  assetVersion: 3,
  productIds: [product],
  ownerIds: [],
  ...overrides,
});
const variant = (
  fileUploadId: string,
  variantKind: string,
  format: string,
  s3Key: string,
): MarketMediaVariantRow => ({ fileUploadId, variantKind, format, s3Key });
const cover = (fileId = first, productId = product) => ({
  fileId,
  productId,
  assetVersion: 3,
});
function plan<T = string>(
  candidates: Partial<MarketMediaCandidates> = {},
  grant: Partial<MarketPublicMediaGrant<T>> = {},
): MarketPublicMediaPlan<T> {
  return {
    candidates: {
      asOf,
      covers: [],
      logos: [],
      guardedFileIds: [],
      guard: null,
      ...candidates,
    },
    grant: () => ({
      covers: [],
      logos: [],
      guardedFileIds: [],
      value: 'captured' as unknown as T,
      ...grant,
    }),
  };
}
const covers = (...fileIds: string[]) =>
  plan(
    { covers: fileIds.map((id) => cover(id)) },
    { covers: fileIds.map((fileId) => ({ fileId, productId: product })) },
  );

describe('bounded current-public media resolution', () => {
  it('reads parents, files and variants in one statement inside the bounded transaction', async () => {
    const guardRow = { id: product, fileIds: [first] };
    const { service, run, query } = fixture({
      guard: [guardRow],
      files: [file()],
      variants: [variant(first, 'CARD', 'WEBP', 'products/card.webp')],
    });
    const grant = jest.fn().mockReturnValue({
      covers: [{ fileId: first, productId: product }],
      logos: [],
      guardedFileIds: [],
      value: new Set([product]),
    });
    const prepare = jest.fn().mockImplementation(async () => {
      return {
        ...plan({
          covers: [cover()],
          guard: Prisma.sql`SELECT ${product}::text AS id`,
        }),
        grant,
      };
    });
    const result = await service.resolve(prepare);
    expect(run).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(grant).toHaveBeenCalledWith([guardRow]);
    const sql = query.mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).toContain('WITH guard AS MATERIALIZED (SELECT');
    expect(sql.text).toContain('file."processingStatus"=\'READY\'');
    expect(sql.text).toContain('file."originalDeletedAt" IS NULL');
    expect(sql.text).toContain(
      "file.\"mimeType\" IN ('image/jpeg','image/png','image/webp','image/avif','image/gif')",
    );
    expect(sql.values).toContain(MARKET_PUBLIC_MEDIA_MAX_FILES);
    expect(result.value).toEqual(new Set([product]));
    expect([...result.originals.keys()]).toEqual([first]);
    expect([...result.variants.get('CARD')!.keys()]).toEqual([first]);
  });
  it('proves covers by approved association, exact version and current eligibility', async () => {
    const { service, query } = fixture({ files: [file()] });
    await service.resolve(async () => covers(first));
    const sql = query.mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).toContain('media."reviewStatus"=\'APPROVED\'');
    expect(sql.text).toContain('cover."assetVersion"=file."assetVersion"');
    expect(sql.text).toContain('publicationStatus');
    expect(sql.text).toContain("'ACTIVE'");
    expect(sql.text).not.toContain('"UserProfile"');
  });
  it('proves logos by the active owner, the linked profile and, when given, an open store', async () => {
    const { service, query } = fixture({
      files: [file(third, { productIds: [], ownerIds: [owner] })],
    });
    const result = await service.resolve(async () =>
      plan(
        { logos: [{ fileId: third, ownerId: owner, brandId: product }] },
        { logos: [{ fileId: third, ownerId: owner }] },
      ),
    );
    const sql = query.mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).toContain('profile."profileImageId"=logo."fileId"');
    expect(sql.text).toContain("owner.status='ACTIVE'");
    expect(sql.text).toContain('file."fileType"=\'PROFILE_IMAGE\'');
    expect(sql.text).toContain('brand."isStoreOpen"');
    expect([...result.originals.keys()]).toEqual([third]);
  });
  it('never signs a file through a parent the guard did not grant', async () => {
    const { service } = fixture({
      files: [
        // Another public product still proves this file; the granted one does not.
        file(first, { productIds: [otherProduct] }),
        file(second, { productIds: [], ownerIds: [owner] }),
        file(third, { productIds: [product] }),
      ],
      variants: [
        variant(first, 'CARD', 'WEBP', 'products/first.webp'),
        variant(third, 'CARD', 'WEBP', 'products/third.webp'),
      ],
    });
    const result = await service.resolve(async () =>
      plan(
        {
          covers: [cover(first), cover(first, otherProduct), cover(third)],
          logos: [{ fileId: second, ownerId: owner }],
        },
        {
          covers: [
            { fileId: first, productId: product },
            { fileId: third, productId: product },
          ],
        },
      ),
    );
    expect([...result.originals.keys()]).toEqual([third]);
    expect([...result.variants.get('CARD')!.keys()]).toEqual([third]);
  });
  it('signs a guard-proven source file only while the guard still grants it', async () => {
    const row = { files: [file(first, { productIds: [] })] };
    const granted = await fixture(row).service.resolve(async () =>
      plan({ guardedFileIds: [first] }, { guardedFileIds: [first] }),
    );
    expect([...granted.originals.keys()]).toEqual([first]);
    const revoked = await fixture(row).service.resolve(async () =>
      plan({ guardedFileIds: [first] }),
    );
    expect(revoked.originals.size).toBe(0);
  });
  it('requires the active asset version and bounded CARD/AVATAR/BANNER kinds', async () => {
    const { service, query } = fixture({ files: [file()] });
    await service.resolve(async () => covers(first));
    const sql = query.mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).toContain('variant."assetVersion"=files."assetVersion"');
    expect(sql.text).toContain(
      "variant.\"variantKind\" IN ('CARD','AVATAR','BANNER')",
    );
    expect(sql.text).toContain(
      "WHEN 'WEBP' THEN 0 WHEN 'AVIF' THEN 1 WHEN 'JPEG' THEN 2 ELSE 3 END",
    );
  });
  it('keeps the first format in SQL preference order independently for each authorized file and kind', async () => {
    const { service } = fixture({
      files: [file(), file(second, { s3Key: 'products/second-original.jpg' })],
      variants: [
        variant(first, 'AVATAR', 'WEBP', 'products/avatar.webp'),
        variant(first, 'CARD', 'WEBP', 'products/card.webp'),
        variant(first, 'CARD', 'AVIF', 'products/card.avif'),
        variant(second, 'CARD', 'JPEG', 'products/second.jpg'),
      ],
    });
    const result = await service.resolve(async () => covers(first, second));
    const path = (kind: string, id: string) =>
      new URL(result.variants.get(kind)!.get(id)!).pathname;
    expect(path('CARD', first)).toBe('/media/products/card.webp');
    expect(path('AVATAR', first)).toBe('/media/products/avatar.webp');
    expect(path('CARD', second)).toBe('/media/products/second.jpg');
    expect(result.value).toBe('captured');
  });
  it('signs only gateway URLs using encoded object keys after all bounded database work ends', async () => {
    const { service, configRead, query } = fixture({ files: [file()] });
    const result = await service.resolve(async () => covers(first));
    const signed = new URL(result.originals.get(first)!);
    expect(signed.origin).toBe('https://media.example.test');
    expect(signed.pathname).toBe('/media/products/approved%20original.webp');
    expect(signed.searchParams.get('method')).toBe('GET');
    expect(signed.searchParams.get('env')).toBe('test');
    expect(signed.searchParams.get('sig')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(
      configRead.mock.invocationCallOrder[0],
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('an empty batch is safe without gateway credentials and performs no query', async () => {
    const { service, query, configRead } = fixture({}, noGateway);
    const result = await service.resolve(async () => plan());
    expect(result.value).toBe('captured');
    expect(result.originals.size).toBe(0);
    expect(result.variants.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
    expect(configRead).not.toHaveBeenCalled();
  });
  it('still revalidates parents when no file is requested', async () => {
    const { service, query } = fixture({ guard: [{ id: product }] });
    const grant = jest.fn().mockReturnValue(plan().grant([]));
    await service.resolve(async () => ({
      ...plan({ guard: Prisma.sql`SELECT ${product}::text AS id` }),
      grant,
    }));
    expect(query).toHaveBeenCalledTimes(1);
    expect(grant).toHaveBeenCalledWith([{ id: product }]);
  });
  it('does not configure signing when no requested file survives authorization', async () => {
    const { service, configRead } = fixture({
      files: [file()],
      variants: [variant(first, 'CARD', 'WEBP', 'products/card.webp')],
    });
    const result = await service.resolve(async () =>
      plan({ covers: [cover()] }),
    );
    expect(result.originals.size).toBe(0);
    expect(result.variants.size).toBe(0);
    expect(configRead).not.toHaveBeenCalled();
  });
  it('returns controlled 503 when authorized images exist but the gateway is not configured', async () => {
    const { service } = fixture({ files: [file()] }, noGateway);
    await expect(
      service.resolve(async () => covers(first)),
    ).rejects.toMatchObject({
      response: { code: 'CATALOGUE_MEDIA_UNAVAILABLE' },
      status: 503,
    });
  });
  it.each<[string, Partial<MarketMediaCandidates>]>([
    ['an invalid file', { covers: [cover('not-a-file-id')] }],
    ['an invalid product', { covers: [cover(first, 'not-a-product')] }],
    ['an invalid owner', { logos: [{ fileId: first, ownerId: 'nobody' }] }],
    [
      'an invalid brand',
      { logos: [{ fileId: first, ownerId: owner, brandId: 'none' }] },
    ],
    [
      'an oversized batch',
      {
        guardedFileIds: Array.from(
          { length: MARKET_PUBLIC_MEDIA_MAX_FILES + 1 },
          (_, index) =>
            `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
        ),
      },
    ],
  ])('rejects %s before any file access', async (_label, candidates) => {
    const { service, query } = fixture();
    await expect(service.resolve(async () => plan(candidates))).rejects.toThrow(
      RangeError,
    );
    expect(query).not.toHaveBeenCalled();
  });
  it('deduplicates repeated IDs before applying its distinct-file bound', async () => {
    const { service, query } = fixture({ files: [file()] });
    await service.resolve(async () =>
      plan({
        guardedFileIds: Array(MARKET_PUBLIC_MEDIA_MAX_FILES + 1).fill(first),
      }),
    );
    const sql = query.mock.calls[0][0] as Prisma.Sql;
    expect(sql.values.flat().filter((value) => value === first)).toHaveLength(
      1,
    );
  });
  it('propagates parent, database and grant failures and never signs partial authorization', async () => {
    const error = new Error('Authorization unavailable');
    const parent = fixture({ files: [file()] });
    await expect(
      parent.service.resolve(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(parent.query).not.toHaveBeenCalled();
    const database = fixture({ files: [file()] });
    database.query.mockRejectedValueOnce(error);
    await expect(
      database.service.resolve(async () => covers(first)),
    ).rejects.toBe(error);
    const missing = fixture({ files: [file()] });
    missing.query.mockResolvedValueOnce([]);
    await expect(
      missing.service.resolve(async () => covers(first)),
    ).rejects.toThrow('Media authorization unavailable');
    const granting = fixture({ files: [file()] });
    await expect(
      granting.service.resolve(async () => ({
        ...covers(first),
        grant: () => {
          throw error;
        },
      })),
    ).rejects.toBe(error);
    for (const used of [parent, database, missing, granting])
      expect(used.configRead).not.toHaveBeenCalled();
  });
});
