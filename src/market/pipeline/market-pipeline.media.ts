import { Prisma } from '@prisma/client';
import { MarketPublicMediaService } from '../catalog/market-public-media.service';
import { eligibleProductWhere } from '../eligibility/market-eligibility';
import {
  CapturedPipelinePage,
  guardPipelineMembership,
  readCurrentPipelineSources,
  resolveCapturedPipelinePorts,
} from './market-pipeline.database';
import { PipelinePorts } from './market-pipeline.types';
import { PIPELINE_CAPTURE_LIMIT } from './market-pipeline.composer';

export interface PipelineMediaResolver {
  resolve(capture: CapturedPipelinePage): Promise<PipelinePorts>;
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
    const resolved = await this.media.resolve(
      async (tx) => {
        const current = await readCurrentPipelineSources(tx, capture);
        const membership = new Set(
          current.map(
            (row) =>
              `${row.requestKey}:${row.candidate.entityType}:${row.candidate.id}`,
          ),
        );
        const liveProducts = new Set(
          current
            .filter((row) => row.candidate.entityType === 'PRODUCT')
            .map((row) => row.candidate.id),
        );
        const originalRows = new Map(
          capture.rows.map((row) => [
            `${row.requestKey}:${row.candidate.entityType}:${row.candidate.id}`,
            row,
          ]),
        );
        const nonproductIds = [
          ...new Set(
            current
              .filter(
                (row) =>
                  row.candidate.entityType !== 'PRODUCT' &&
                  row.fileId &&
                  row.fileId ===
                    originalRows.get(
                      `${row.requestKey}:${row.candidate.entityType}:${row.candidate.id}`,
                    )?.fileId,
              )
              .map((row) => row.fileId!),
          ),
        ];
        const products = capture.products.filter((card) =>
          liveProducts.has(card.product.id),
        );
        const conditions: Prisma.FileUploadWhereInput[] = products.map(
          (card) => ({
            id: card.file.id,
            assetVersion: card.file.assetVersion,
            productMedias: {
              some: {
                productId: card.product.id,
                reviewStatus: 'APPROVED',
                product: eligibleProductWhere(capture.context.asOf),
              },
            },
          }),
        );
        for (const card of products)
          if (card.logoFileId)
            conditions.push({
              id: card.logoFileId,
              userId: card.product.brand.owner.id,
              fileType: 'PROFILE_IMAGE',
              userProfileImages: {
                some: {
                  userId: card.product.brand.owner.id,
                  user: {
                    status: 'ACTIVE',
                    brand: { id: card.product.brand.id, isStoreOpen: true },
                  },
                },
              },
            });
        // Exact approved public parent joins selected these IDs in the current
        // source batch above, inside this same authorization transaction.
        if (nonproductIds.length)
          conditions.push({ id: { in: nonproductIds } });
        const fileIds = [
          ...new Set([
            ...products.flatMap((card) => [
              card.file.id,
              ...(card.logoFileId ? [card.logoFileId] : []),
            ]),
            ...nonproductIds,
          ]),
        ];
        return { fileIds, fileWhere: { OR: conditions }, value: membership };
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
