import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContentMediaViewSlot } from '@prisma/client';
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
import {
  MarketMediaAuthorityRow,
  MarketMediaCandidates,
  marketMediaAuthoritySql,
} from './market-public-media.sql';

/** Exact parents the guard returned; a file needs one of its own to be signed. */
export interface MarketPublicMediaGrant<T> {
  readonly covers: readonly { fileId: string; productId: string }[];
  readonly logos: readonly { fileId: string; ownerId: string }[];
  readonly guardedFileIds: readonly string[];
  readonly value: T;
  readonly sources?: readonly { fileId: string; source: FileReadSource }[];
}
export interface MarketPublicMediaPlan<T> {
  readonly candidates: MarketMediaCandidates;
  /** Pure decision over the guard rows of the same statement. */
  readonly grant: (guard: readonly unknown[]) => MarketPublicMediaGrant<T>;
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

/** Parent authorization is a server-owned query inside the SAME statement that
 * reads the files. No endpoint accepts a callback or caller-vouched IDs. */
@Injectable()
export class MarketPublicMediaService {
  constructor(
    private readonly reads: MarketCatalogReadService,
    private readonly config: ConfigService,
  ) {}

  async resolve<T>(
    prepare: () => Promise<MarketPublicMediaPlan<T>>,
    options: MarketReadOptions = {},
  ): Promise<MarketPublicMediaResult<T>> {
    assertMarketReadDeadline(options);
    const plan = await prepare();
    const read = await (async () => {
      const { candidates } = plan;
      const ids = new Set([
        ...candidates.covers.map((cover) => cover.fileId),
        ...candidates.logos.map((logo) => logo.fileId),
        ...candidates.guardedFileIds,
      ]);
      if (
        ids.size > MARKET_PUBLIC_MEDIA_MAX_FILES ||
        [...ids].some((id) => !uuid.test(id)) ||
        [...candidates.covers].some((cover) => !uuid.test(cover.productId)) ||
        [...candidates.logos].some(
          (logo) =>
            !uuid.test(logo.ownerId) ||
            (logo.brandId !== undefined && !uuid.test(logo.brandId)),
        )
      )
        throw new RangeError('Invalid public media batch');
      // Parents, files and variants in one statement and one snapshot.
      const rows =
        ids.size || candidates.guard
          ? await this.reads.statement<MarketMediaAuthorityRow[]>(
              marketMediaAuthoritySql(
                candidates,
                MARKET_PUBLIC_MEDIA_MAX_FILES,
              ),
              options,
            )
          : [];
      if ((ids.size || candidates.guard) && rows.length !== 1)
        throw new Error('Media authorization unavailable');
      return { plan, row: rows[0] ?? { guard: [], files: [], variants: [] } };
    })();
    assertMarketReadDeadline(options);
    const grant = read.plan.grant(read.row.guard);
    const key = (fileId: string, parent: string) => `${fileId}:${parent}`;
    const grantedProducts = new Set(
      grant.covers.map((cover) => key(cover.fileId, cover.productId)),
    );
    const grantedOwners = new Set(
      grant.logos.map((logo) => key(logo.fileId, logo.ownerId)),
    );
    const guarded = new Set(grant.guardedFileIds);
    const files = read.row.files.filter(
      (file) =>
        guarded.has(file.id) ||
        file.productIds.some((id) => grantedProducts.has(key(file.id, id))) ||
        file.ownerIds.some((id) => grantedOwners.has(key(file.id, id))),
    );
    const readSources = new Map<string, FileReadSource[]>();
    for (const item of grant.sources ?? []) {
      const entries = readSources.get(item.fileId) ?? [];
      entries.push(item.source);
      readSources.set(item.fileId, entries);
    }
    const captured = {
      value: grant.value,
      files,
      variants: read.row.variants,
      sources: readSources,
    };
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
