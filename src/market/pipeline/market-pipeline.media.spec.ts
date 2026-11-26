import {
  MarketPublicMediaPlan,
  MarketPublicMediaService,
} from '../catalog/market-public-media.service';
import {
  CapturedPipelinePage,
  pipelineRequestKey,
} from './market-pipeline.database';
import { PipelineDatabaseRow } from './market-pipeline.database.sql';
import { MarketPipelineMediaResolver } from './market-pipeline.media';
import {
  PipelineCandidate,
  PipelineContext,
  PipelineSourceRequest,
} from './market-pipeline.types';

const id = '11111111-1111-4111-8111-111111111111';
const fileId = '22222222-2222-4222-8222-222222222222';
const otherFileId = '33333333-3333-4333-8333-333333333333';
const asOf = new Date('2026-11-21T12:00:00.000Z');
const context = {
  signedIn: false,
  retentionHours: 24,
  personalEnabled: false,
  regionalEnabled: false,
  asOf,
  epoch: null,
  surface: 'HOME',
  filters: {},
  suppression: {
    targetKeys: new Set(),
    brandIds: new Set(),
    categoryIds: new Set(),
    sectionKeys: new Set(),
  },
  tenure: new Map(),
} as PipelineContext;
const request: PipelineSourceRequest = {
  sectionKey: 'runway',
  source: { kind: 'from_runway' },
  fixedFilterLayers: [{}],
  filters: {},
  asOf,
  epoch: null,
  limit: 100,
  suppressionMode: 'public_pool',
  signal: new AbortController().signal,
};
const key = pipelineRequestKey(request);
const candidate = {
  id,
  entityType: 'DESIGN',
  brandId: null,
  categoryId: null,
  firstPublishedAt: asOf.toISOString(),
  brandCreatedAt: null,
  tags: [],
  dimensions: [],
  features: {
    popularity: null,
    quality: null,
    trend: null,
    trendRatio: null,
    actors7d: null,
    trendEligible: false,
    intent7d: null,
    minStock: null,
    sourceOrder: 0,
    similarity: null,
  },
} as PipelineCandidate;
const row: PipelineDatabaseRow = {
  requestKey: key,
  candidate,
  amount: null,
  fileId,
  scarcity: null,
  projection: {
    id,
    sourceId: id,
    sourceType: 'DESIGN',
    entityType: 'DESIGN',
    title: 'Public design',
    subtitle: null,
    description: null,
    brand: null,
    media: null,
    price: null,
    priceRange: null,
    availability: null,
    category: null,
    tags: [],
    stats: { views: null, threads: null, products: null },
    target: { type: 'DESIGN', id, key: id, route: `/designs/${id}` },
    createdAt: null,
    updatedAt: null,
  },
};
function capture(): CapturedPipelinePage {
  return {
    viewer: {},
    context,
    specs: [],
    products: [],
    rows: [row],
    requests: [
      { key, request, spec: {} as CapturedPipelinePage['specs'][number] },
    ],
    captureIds: new Set([`DESIGN:${id}`]),
    cacheWrites: [],
  };
}

describe('Market pipeline bounded shared media authorization', () => {
  function service(currentRows: readonly PipelineDatabaseRow[]) {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(0) };
    let plan: MarketPublicMediaPlan<ReadonlySet<string>> | undefined;
    let fileIds: readonly string[] = [];
    const media = {
      resolve: jest.fn(async (prepare) => {
        plan = (await prepare(tx)) as NonNullable<typeof plan>;
        const granted = plan.grant(
          currentRows.map((current) => ({
            requestKey: current.requestKey,
            entityType: current.candidate.entityType,
            id: current.candidate.id,
            fileId: current.fileId,
          })),
        );
        fileIds = granted.guardedFileIds;
        return {
          value: granted.value,
          originals: new Map(
            fileIds.map((fileId) => [fileId, 'https://gateway.example/signed']),
          ),
          variants: new Map(),
        };
      }),
    };
    return { media, fileIds: () => fileIds, plan: () => plan! };
  }
  it('authorizes the exact current approved public source file inside the shared transaction', async () => {
    const fake = service([row]);
    const resolver = new MarketPipelineMediaResolver(
      fake.media as unknown as Pick<MarketPublicMediaService, 'resolve'>,
    );
    const ports = await resolver.resolve(capture());
    const candidates = await ports.retrieve(request);
    const items = await ports.hydrate(candidates, asOf, request.signal);
    expect(items[0].item.media?.url).toBe('https://gateway.example/signed');
    expect(fake.fileIds()).toEqual([fileId]);
    expect(fake.media.resolve).toHaveBeenCalledTimes(1);
    expect(fake.plan().candidates).toMatchObject({
      covers: [],
      logos: [],
      guardedFileIds: [fileId],
    });
    const query = fake.plan().candidates.guard!;
    expect(query.text).toContain("c.visibility='PUBLIC'");
    expect(query.text).toContain('media."reviewStatus"=\'APPROVED\'');
  });
  it('drops a newly private source and never authorizes a replacement file by URL matching', async () => {
    const revoked = service([]);
    const revokedPorts = await new MarketPipelineMediaResolver(
      revoked.media as unknown as Pick<MarketPublicMediaService, 'resolve'>,
    ).resolve(capture());
    expect(await revokedPorts.retrieve(request)).toEqual([candidate]);
    expect(
      await revokedPorts.hydrate([candidate], asOf, request.signal, request),
    ).toEqual([]);
    expect(revoked.fileIds()).toEqual([]);
    const replaced = service([{ ...row, fileId: otherFileId }]);
    const changedPorts = await new MarketPipelineMediaResolver(
      replaced.media as unknown as Pick<MarketPublicMediaService, 'resolve'>,
    ).resolve(capture());
    expect(replaced.fileIds()).toEqual([]);
    expect(
      await changedPorts.hydrate([candidate], asOf, request.signal),
    ).toEqual([]);
  });
});
