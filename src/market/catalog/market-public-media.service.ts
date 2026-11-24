import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, ContentMediaViewSlot } from '@prisma/client';
import {
  resolveStorageProviderSettings,
  signPublicGatewayUrl,
} from '../../upload/storage-provider.config';
import {
  MarketCatalogReadService,
  MarketReadOptions,
  assertMarketReadDeadline,
} from './market-catalog-read.service';
import {
  rememberReadResource,
  FileReadSource,
} from '../../auth/access/read-resource-context';

export interface MarketPublicMediaAuthorization<T> {
  readonly fileIds: readonly string[];
  readonly fileWhere: Prisma.FileUploadWhereInput;
  readonly value: T;
  readonly sources?: readonly { fileId: string; source: FileReadSource }[];
}
export interface MarketPublicMediaResult<T> {
  readonly value: T;
  readonly originals: Map<string, string>;
  readonly variants: ReadonlyMap<string, Map<string, string>>;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// One cover/gallery per unique product view slot, plus one profile logo, for
// the existing maximum 61 captured products. Never clip an approved gallery.
export const MARKET_PUBLIC_MEDIA_MAX_FILES =
  61 * (Object.values(ContentMediaViewSlot).length + 1);

/** Parent authorization is performed by a server-owned query in the SAME
 * bounded transaction. No endpoint accepts a callback or caller-vouched IDs. */
@Injectable()
export class MarketPublicMediaService {
  constructor(
    private readonly reads: MarketCatalogReadService,
    private readonly config: ConfigService,
  ) {}

  async resolve<T>(
    authorize: (
      tx: Prisma.TransactionClient,
    ) => Promise<MarketPublicMediaAuthorization<T>>,
    options: MarketReadOptions = {},
  ): Promise<MarketPublicMediaResult<T>> {
    const captured = await this.reads.run(async (tx) => {
      const authorization = await authorize(tx);
      const ids = [...new Set(authorization.fileIds)];
      if (
        ids.length > MARKET_PUBLIC_MEDIA_MAX_FILES ||
        ids.some((id) => !uuid.test(id))
      )
        throw new RangeError('Invalid public media batch');
      const files = ids.length
        ? await tx.fileUpload.findMany({
            where: {
              id: { in: ids },
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
              AND: [authorization.fileWhere],
            },
            select: { id: true, s3Key: true, assetVersion: true },
            take: MARKET_PUBLIC_MEDIA_MAX_FILES,
          })
        : [];
      const variants = files.length
        ? await tx.$queryRaw<
            Array<{
              fileUploadId: string;
              s3Key: string;
              variantKind: string;
              format: string;
            }>
          >(Prisma.sql`
        SELECT variant."fileUploadId",variant."s3Key",variant."variantKind",variant.format
        FROM "FileVariant" variant JOIN "FileUpload" file ON file."_id"=variant."fileUploadId"
          AND file."assetVersion"=variant."assetVersion"
        WHERE file."_id" IN (${Prisma.join(files.map((file) => Prisma.sql`${file.id}::uuid`))})
          AND variant."variantKind" IN ('CARD','AVATAR','BANNER')
        ORDER BY variant."fileUploadId",variant."variantKind",CASE variant.format::text WHEN 'WEBP' THEN 0 WHEN 'AVIF' THEN 1 WHEN 'JPEG' THEN 2 ELSE 3 END,variant."_id"`)
        : [];
      const sources = new Map<string, FileReadSource[]>();
      for (const item of authorization.sources ?? []) {
        const entries = sources.get(item.fileId) ?? [];
        entries.push(item.source);
        sources.set(item.fileId, entries);
      }
      return { value: authorization.value, files, variants, sources };
    }, options);
    assertMarketReadDeadline(options);
    const originals = new Map<string, string>(),
      variants = new Map<string, Map<string, string>>();
    if (!captured.files.length)
      return { value: captured.value, originals, variants };
    let gateway: ReturnType<
      typeof resolveStorageProviderSettings
    >['publicGateway'];
    try {
      gateway = resolveStorageProviderSettings(this.config).publicGateway;
    } catch {
      throw new ServiceUnavailableException({
        code: 'CATALOGUE_MEDIA_UNAVAILABLE',
        message: 'Media delivery is updating. Please try again shortly.',
      });
    }
    if (!gateway)
      throw new ServiceUnavailableException({
        code: 'CATALOGUE_MEDIA_UNAVAILABLE',
        message: 'Media delivery is updating. Please try again shortly.',
      });
    // Local HMAC only: no provider call, database work or connection held here.
    const byId = new Map(captured.files.map((file) => [file.id, file]));
    const remember = (id: string, variantKey?: string) => {
      const file = byId.get(id);
      if (!file) return;
      const sources = captured.sources.get(id) ?? [undefined];
      for (const source of sources)
        rememberReadResource({
          type: 'FILE',
          id,
          publicOnly: true,
          key: file.s3Key,
          assetVersion: file.assetVersion,
          variantKey,
          source,
          privateCollectionsEnabled:
            this.config.get<string>('FEATURE_PRIVATE_COLLECTIONS') !== 'false',
        });
    };
    for (const file of captured.files) {
      remember(file.id);
      originals.set(file.id, signPublicGatewayUrl(gateway, file.s3Key));
    }
    for (const variant of captured.variants) {
      if (!byId.has(variant.fileUploadId)) continue;
      const byKind =
        variants.get(variant.variantKind) ?? new Map<string, string>();
      if (!byKind.has(variant.fileUploadId)) {
        remember(variant.fileUploadId, variant.s3Key);
        byKind.set(
          variant.fileUploadId,
          signPublicGatewayUrl(gateway, variant.s3Key),
        );
      }
      variants.set(variant.variantKind, byKind);
    }
    assertMarketReadDeadline(options);
    return { value: captured.value, originals, variants };
  }
}
