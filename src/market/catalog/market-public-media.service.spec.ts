import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { MarketCatalogReadService } from './market-catalog-read.service';
import {
  MarketPublicMediaService,
  MARKET_PUBLIC_MEDIA_MAX_FILES,
} from './market-public-media.service';

const first = '00000000-0000-0000-0000-000000000001';
const second = '00000000-0000-0000-0000-000000000002';
const third = '00000000-0000-0000-0000-000000000003';
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
type File = { id: string; s3Key: string; assetVersion: number };
type Variant = {
  fileUploadId: string;
  s3Key: string;
  variantKind: string;
  format: string;
};
function fixture(
  files: File[] = [],
  variants: Variant[] = [],
  overrides: Record<string, string | undefined> = {},
) {
  let inside = false;
  const findFiles = jest.fn().mockImplementation(async () => {
    expect(inside).toBe(true);
    return files;
  });
  const query = jest.fn().mockImplementation(async () => {
    expect(inside).toBe(true);
    return variants;
  });
  const tx = {
    fileUpload: { findMany: findFiles },
    $queryRaw: query,
  } as unknown as Prisma.TransactionClient;
  const run = jest
    .fn()
    .mockImplementation(
      async (read: (value: Prisma.TransactionClient) => Promise<unknown>) => {
        expect(inside).toBe(false);
        inside = true;
        try {
          return await read(tx);
        } finally {
          inside = false;
        }
      },
    );
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
    { run } as unknown as MarketCatalogReadService,
    { get: configRead } as unknown as ConfigService,
  );
  return { service, tx, run, findFiles, query, configRead };
}
const file = (id = first, s3Key = 'products/approved original.webp'): File => ({
  id,
  s3Key,
  assetVersion: 3,
});

describe('bounded current-public media resolution', () => {
  it('runs server parent authorization and file reads in the same bounded transaction', async () => {
    const { service, tx, run, findFiles } = fixture([file()]);
    const where: Prisma.FileUploadWhereInput = {
      productMedias: { some: { productId: second, reviewStatus: 'APPROVED' } },
    };
    const authorize = jest.fn().mockImplementation(async (received) => {
      expect(received).toBe(tx);
      return {
        fileIds: [first, first, third],
        fileWhere: where,
        value: new Set([second]),
      };
    });
    const result = await service.resolve(authorize);
    expect(run).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(findFiles).toHaveBeenCalledWith({
      where: {
        id: { in: [first, third] },
        processingStatus: 'READY',
        originalDeletedAt: null,
        mimeType: {
          in: [
            'image/jpeg',
            'image/png',
            'image/webp',
            'image/avif',
            'image/gif',
          ],
        },
        AND: [where],
      },
      select: { id: true, s3Key: true, assetVersion: true },
      take: MARKET_PUBLIC_MEDIA_MAX_FILES,
    });
    expect(result.value).toEqual(new Set([second]));
    expect([...result.originals.keys()]).toEqual([first]);
    expect(result.originals.has(third)).toBe(false);
  });
  it('never places unapproved or missing original IDs into the variant lookup or signed maps', async () => {
    const { service, query } = fixture(
      [file()],
      [
        {
          fileUploadId: first,
          variantKind: 'CARD',
          format: 'WEBP',
          s3Key: 'products/card.webp',
        },
      ],
    );
    const result = await service.resolve(async () => ({
      fileIds: [first, second],
      fileWhere: { id: first },
      value: null,
    }));
    const sql = query.mock.calls[0][0] as Prisma.Sql;
    expect(sql.values).toEqual([first]);
    expect(sql.values).not.toContain(second);
    expect([...result.originals.keys()]).toEqual([first]);
    expect([...result.variants.get('CARD')!.keys()]).toEqual([first]);
  });
  it('requires the active asset version and bounded CARD/AVATAR/BANNER kinds', async () => {
    const { service, query } = fixture([file()]);
    await service.resolve(async () => ({
      fileIds: [first],
      fileWhere: {},
      value: true,
    }));
    const sql = query.mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).toContain('file."assetVersion"=variant."assetVersion"');
    expect(sql.text).toContain(
      "variant.\"variantKind\" IN ('CARD','AVATAR','BANNER')",
    );
    expect(sql.text).toContain(
      "WHEN 'WEBP' THEN 0 WHEN 'AVIF' THEN 1 WHEN 'JPEG' THEN 2 ELSE 3 END",
    );
  });
  it('keeps the first format in SQL preference order independently for each authorized file and kind', async () => {
    const variants: Variant[] = [
      {
        fileUploadId: first,
        variantKind: 'AVATAR',
        format: 'WEBP',
        s3Key: 'products/avatar.webp',
      },
      {
        fileUploadId: first,
        variantKind: 'CARD',
        format: 'WEBP',
        s3Key: 'products/card.webp',
      },
      {
        fileUploadId: first,
        variantKind: 'CARD',
        format: 'AVIF',
        s3Key: 'products/card.avif',
      },
      {
        fileUploadId: second,
        variantKind: 'CARD',
        format: 'JPEG',
        s3Key: 'products/second.jpg',
      },
    ];
    const { service } = fixture(
      [file(), file(second, 'products/second-original.jpg')],
      variants,
    );
    const result = await service.resolve(async () => ({
      fileIds: [first, second],
      fileWhere: {},
      value: 'captured',
    }));
    expect(new URL(result.variants.get('CARD')!.get(first)!).pathname).toBe(
      '/media/products/card.webp',
    );
    expect(new URL(result.variants.get('AVATAR')!.get(first)!).pathname).toBe(
      '/media/products/avatar.webp',
    );
    expect(new URL(result.variants.get('CARD')!.get(second)!).pathname).toBe(
      '/media/products/second.jpg',
    );
    expect(result.value).toBe('captured');
  });
  it('signs only gateway URLs using encoded object keys after all bounded database work ends', async () => {
    const { service, configRead, findFiles, query } = fixture([file()]);
    const result = await service.resolve(async () => ({
      fileIds: [first],
      fileWhere: {},
      value: 1,
    }));
    const signed = new URL(result.originals.get(first)!);
    expect(signed.origin).toBe('https://media.example.test');
    expect(signed.pathname).toBe('/media/products/approved%20original.webp');
    expect(signed.searchParams.get('method')).toBe('GET');
    expect(signed.searchParams.get('env')).toBe('test');
    expect(signed.searchParams.get('sig')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(findFiles.mock.invocationCallOrder[0]).toBeLessThan(
      configRead.mock.invocationCallOrder[0],
    );
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(
      configRead.mock.invocationCallOrder[0],
    );
    expect(findFiles).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('an empty authorized batch is safe without gateway credentials and performs no file query', async () => {
    const { service, findFiles, query, configRead } = fixture([], [], {
      MEDIA_GATEWAY_BASE_URL: undefined,
      MEDIA_GATEWAY_SECRET: undefined,
      MEDIA_GATEWAY_ENVIRONMENT: undefined,
      MEDIA_GATEWAY_TTL_SECONDS: undefined,
    });
    const result = await service.resolve(async () => ({
      fileIds: [],
      fileWhere: {},
      value: 'empty',
    }));
    expect(result.value).toBe('empty');
    expect(result.originals.size).toBe(0);
    expect(result.variants.size).toBe(0);
    expect(findFiles).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(configRead).not.toHaveBeenCalled();
  });
  it('does not query variants or configure signing when no requested files survive authorization', async () => {
    const { service, query, configRead } = fixture();
    const result = await service.resolve(async () => ({
      fileIds: [first],
      fileWhere: { id: second },
      value: false,
    }));
    expect(result.originals.size).toBe(0);
    expect(result.variants.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
    expect(configRead).not.toHaveBeenCalled();
  });
  it('returns controlled 503 when authorized images exist but the gateway is not configured', async () => {
    const { service } = fixture([file()], [], {
      MEDIA_GATEWAY_BASE_URL: undefined,
      MEDIA_GATEWAY_SECRET: undefined,
      MEDIA_GATEWAY_ENVIRONMENT: undefined,
      MEDIA_GATEWAY_TTL_SECONDS: undefined,
    });
    await expect(
      service.resolve(async () => ({
        fileIds: [first],
        fileWhere: {},
        value: null,
      })),
    ).rejects.toMatchObject({
      response: { code: 'CATALOGUE_MEDIA_UNAVAILABLE' },
      status: 503,
    });
  });
  it.each([
    ['invalid UUID', ['not-a-file-id']],
    [
      'oversized batch',
      Array.from(
        { length: MARKET_PUBLIC_MEDIA_MAX_FILES + 1 },
        (_, index) =>
          `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
      ),
    ],
  ])('rejects %s before file access', async (_label, ids) => {
    const { service, findFiles, query } = fixture();
    await expect(
      service.resolve(async () => ({
        fileIds: ids as string[],
        fileWhere: {},
        value: null,
      })),
    ).rejects.toThrow(RangeError);
    expect(findFiles).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it('deduplicates repeated IDs before applying its distinct-file bound', async () => {
    const { service, findFiles } = fixture([file()]);
    await service.resolve(async () => ({
      fileIds: Array(300).fill(first),
      fileWhere: {},
      value: null,
    }));
    expect(findFiles.mock.calls[0][0].where.id.in).toEqual([first]);
  });
  it('propagates parent/database failures and never signs partial authorization', async () => {
    const { service, findFiles, configRead } = fixture([file()]),
      error = new Error('Authorization unavailable');
    await expect(
      service.resolve(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(findFiles).not.toHaveBeenCalled();
    expect(configRead).not.toHaveBeenCalled();
    findFiles.mockRejectedValueOnce(error);
    await expect(
      service.resolve(async () => ({
        fileIds: [first],
        fileWhere: {},
        value: null,
      })),
    ).rejects.toBe(error);
    expect(configRead).not.toHaveBeenCalled();
  });
});
