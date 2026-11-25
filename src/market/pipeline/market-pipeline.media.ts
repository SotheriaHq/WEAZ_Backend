import { Prisma } from '@prisma/client';
import { MarketPublicMediaService } from '../catalog/market-public-media.service';
import {
  CapturedPipelinePage,
  currentPipelineSourcesSql,
  guardPipelineMembership,
  resolveCapturedPipelinePorts,
} from './market-pipeline.database';
import { PipelinePorts } from './market-pipeline.types';
import { PIPELINE_CAPTURE_LIMIT } from './market-pipeline.composer';

export interface PipelineMediaResolver {
  resolve(capture: CapturedPipelinePage): Promise<PipelinePorts>;
}
interface CurrentSource {
  readonly requestKey: string;
  readonly entityType: string;
  readonly id: string;
  readonly fileId: string | null;
}

/** Same bounded public media gateway as catalogue cards; no legacy upload queries. */
export class MarketPipelineMediaResolver implements PipelineMediaResolver {
  constructor(
    private readonly media: Pick<MarketPublicMediaService, 'resolve'>,
  ) {}
  async resolve(capture: CapturedPipelinePage): Promise<PipelinePorts> {
    if (
      capture.captureIds.size > PIPELINE_CAPTURE_LIMIT ||
      capture.context.signal?.aborted
    )
      throw new Error('Request context ended');
    const originalFiles = new Map(
      capture.rows.map((row) => [
        `${row.requestKey}:${row.candidate.entityType}:${row.candidate.id}`,
        row.fileId,
      ]),
    );
    const logoOf = (card: CapturedPipelinePage['products'][number]) =>
      card.logoFileId
        ? [
            {
              fileId: card.logoFileId,
              ownerId: card.product.brand.owner.id,
              brandId: card.product.brand.id,
            },
          ]
        : [];
    const resolved = await this.media.resolve<ReadonlySet<string>>(
      async (tx) => {
        if (!Number.isFinite(capture.context.deadline))
          await tx.$executeRaw`SET LOCAL statement_timeout='250ms'`;
        const current = currentPipelineSourcesSql(capture);
        return {
          candidates: {
            asOf: capture.context.asOf,
            covers: capture.products.map((card) => ({
              fileId: card.file.id,
              assetVersion: card.file.assetVersion,
              productId: card.product.id,
            })),
            logos: capture.products.flatMap(logoOf),
            guardedFileIds: capture.rows.flatMap((row) =>
              row.candidate.entityType !== 'PRODUCT' &&
              row.fileId &&
              capture.captureIds.has(
                `${row.candidate.entityType}:${row.candidate.id}`,
              )
                ? [row.fileId]
                : [],
            ),
            guard: current
              ? Prisma.sql`SELECT source."requestKey",source.candidate->>'entityType' AS "entityType",source.candidate->>'id' AS id,source."fileId" FROM (${current}) source`
              : null,
          },
          grant: (guard) => {
            const sources = guard as readonly CurrentSource[];
            const keyOf = (source: CurrentSource) =>
              `${source.requestKey}:${source.entityType}:${source.id}`;
            const live = new Set(
              sources
                .filter((source) => source.entityType === 'PRODUCT')
                .map((source) => source.id),
            );
            const cards = capture.products.filter((card) =>
              live.has(card.product.id),
            );
            return {
              covers: cards.map((card) => ({
                fileId: card.file.id,
                productId: card.product.id,
              })),
              logos: cards.flatMap(logoOf),
              // The guard joined this exact approved file to its public parent
              // in the same statement; a replacement file is never granted.
              guardedFileIds: sources.flatMap((source) =>
                source.entityType !== 'PRODUCT' &&
                source.fileId &&
                source.fileId === originalFiles.get(keyOf(source))
                  ? [source.fileId]
                  : [],
              ),
              value: new Set(sources.map(keyOf)),
            };
          },
        };
      },
      { deadline: capture.context.deadline, signal: capture.context.signal },
    );
    const cardVariants =
      resolved.variants.get('CARD') ?? new Map<string, string>();
    const ports = await resolveCapturedPipelinePorts(capture, {
      getBatchPublicSignedUrls: async (ids) =>
        new Map(
          ids.flatMap((id) =>
            resolved.originals.has(id)
              ? [[id, resolved.originals.get(id)!] as const]
              : [],
          ),
        ),
      getBatchVariantDisplayUrls: async (ids) =>
        new Map(
          ids.flatMap((id) =>
            cardVariants.has(id) ? [[id, cardVariants.get(id)!] as const] : [],
          ),
        ),
    });
    return guardPipelineMembership(ports, resolved.value);
  }
}
