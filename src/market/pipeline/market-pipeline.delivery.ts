import { Prisma } from '@prisma/client';
import { eligibleProductSql } from '../eligibility/market-eligibility';
import { PipelineContext, PipelineSection } from './market-pipeline.types';
const pipelineUuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Explicit serializer keeps trusted source objects out of client-controlled state. */
export function serializePipelinePage(page: {
  generatedAt: string;
  epoch: string | null;
  sections: readonly PipelineSection[];
  metadata: { partial: boolean; cachePolicy: 'private-no-store' };
}) {
  return {
    generatedAt: page.generatedAt,
    epoch: page.epoch,
    metadata: page.metadata,
    sections: page.sections.map((section) => ({
      key: section.key,
      template: section.template,
      title: section.title,
      subtitle: section.subtitle,
      reason: null,
      layout:
        section.template === 'CATEGORY_TILES'
          ? ('CATEGORY_GRID' as const)
          : section.template === 'LOOKS'
            ? ('COLLECTION_RAIL' as const)
            : section.template === 'NEW_DESIGNERS'
              ? ('BRAND_RAIL' as const)
              : ('HORIZONTAL_RAIL' as const),
      policy: section.policy,
      policyVersion: section.policyVersion,
      personalization: section.personalization,
      items: section.items,
      viewAll: {
        ...section.viewAll,
        route: `/market/sections/${encodeURIComponent(section.key)}`,
        label: 'View all',
      },
      metadata: section.metadata,
    })),
  };
}

export interface PipelineExposureReceipt {
  readonly kind: 'market-pipeline-exposure-receipt';
}
const exposureReceipts = new WeakMap<
  PipelineExposureReceipt,
  {
    readonly sections: readonly PipelineSection[];
    readonly context: Pick<PipelineContext, 'epoch' | 'asOf'>;
  }
>();

/** Only the server page builder mints this receipt after final media membership. */
export function createPipelineExposureReceipt(
  sections: readonly PipelineSection[],
  context: Pick<PipelineContext, 'epoch' | 'asOf'>,
): PipelineExposureReceipt {
  const receipt = Object.freeze({
    kind: 'market-pipeline-exposure-receipt' as const,
  });
  exposureReceipts.set(receipt, {
    sections: sections
      .filter((section) =>
        ['TREND', 'CATALOG_POPULAR', 'STARTER_PICKS', 'NEW_DESIGNERS'].includes(
          section.template,
        ),
      )
      .map((section) => ({
        ...section,
        items: [],
        exposures:
          section.template === 'NEW_DESIGNERS'
            ? (section.exposures ?? []).map((item) => ({ ...item }))
            : section.items
                .filter((item) => item.entityType === 'PRODUCT')
                .map((item) => ({
                  productId: item.id,
                  position: item.position,
                })),
      })),
    context: {
      asOf: new Date(context.asOf),
      epoch: context.epoch ? { ...context.epoch } : null,
    },
  });
  return receipt;
}

/** Separate server-only write after the read-only capture transaction has ended.
 * A JSON-shaped forged receipt cannot authorize a write. Retries stay idempotent. */
export async function writePipelineExposures(
  db: Pick<Prisma.TransactionClient, '$executeRaw'>,
  receipt: PipelineExposureReceipt,
): Promise<number> {
  const authorization = exposureReceipts.get(receipt);
  if (!authorization) throw new RangeError('Invalid exposure receipt');
  const { sections, context } = authorization;
  if (sections.length > 8)
    throw new RangeError('Exposure section capacity exceeded');
  if (!Number.isFinite(context.asOf.getTime()))
    throw new RangeError('Invalid exposure clock');
  const epochStart =
    context.epoch?.epochStart ??
    new Date(
      Math.floor(context.asOf.getTime() / 21600000) * 21600000,
    ).toISOString();
  const rows = sections.flatMap((section) =>
    (
      section.exposures ??
      section.items
        .filter((item) => item.entityType === 'PRODUCT')
        .map((item) => ({ productId: item.id, position: item.position }))
    ).map((item) => ({
      sectionKey: section.key,
      productId: item.productId,
      slot: item.position,
    })),
  );
  if (
    rows.length > 96 ||
    rows.some(
      (row) =>
        !/^[a-z0-9][a-z0-9-]{0,79}$/.test(row.sectionKey) ||
        !pipelineUuid.test(row.productId) ||
        !Number.isInteger(row.slot) ||
        row.slot < 0 ||
        row.slot > 11,
    )
  )
    throw new RangeError('Invalid exposure write');
  if (!rows.length) return 0;
  const values = rows.map(
    (row) =>
      Prisma.sql`(${row.sectionKey},${row.productId}::uuid,${epochStart}::timestamptz,${context.epoch?.id ?? null}::uuid,${row.slot})`,
  );
  return db.$executeRaw(Prisma.sql`INSERT INTO market_section_exposure("sectionKey","productId",epoch,"epochId",slot)
    SELECT input.* FROM (VALUES ${Prisma.join(values)}) AS input("sectionKey","productId",epoch,"epochId",slot)
    LEFT JOIN market_feature_epochs e ON e.id=input."epochId" AND e.status='READY' AND e."stateKey"='market.features.v1.r1'
      AND e."acceptUntil">${context.asOf.toISOString()}::timestamptz
    JOIN "Product" p ON p."_id"=input."productId"
    WHERE (input."epochId" IS NULL OR e.id IS NOT NULL) AND ${eligibleProductSql(context.asOf)}
    ON CONFLICT("sectionKey","productId",epoch) DO NOTHING`);
}

export interface PipelineRedisClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
  hGet(key: string, field: string): Promise<string | null>;
}
const putScript = `
local key=KEYS[1]
local expiry=KEYS[2]
local field=ARGV[1]
local expired=redis.call('ZRANGEBYSCORE',expiry,'-inf',ARGV[3],'LIMIT',0,256)
for _,item in ipairs(expired) do redis.call('HDEL',key,item) redis.call('ZREM',expiry,item) end
if redis.call('HEXISTS',key,field)==0 and redis.call('HLEN',key)>=256 then return 0 end
redis.call('HSET',key,field,ARGV[2])
redis.call('ZADD',expiry,ARGV[4],field)
redis.call('EXPIRE',key,120)
redis.call('EXPIRE',expiry,120)
return 1`;

/** One bounded Redis hash, no per-filter key expansion under noeviction. */
export class RedisPipelineCandidateCache {
  private failures = 0;
  private openUntil = 0;
  private pending = 0;
  constructor(
    private readonly redis: PipelineRedisClient,
    private readonly clock = () => Date.now(),
    private readonly namespace = 'mkt:cand:v2',
  ) {
    if (!/^mkt:cand:v2(?::test:[a-f0-9]{32})?$/.test(namespace))
      throw new RangeError('Invalid candidate cache namespace');
  }
  private async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.openUntil > this.clock())
      throw new Error('Candidate cache unavailable');
    if (this.pending >= 4) throw new Error('Candidate cache busy');
    this.pending++;
    // A timed-out command retains admission until the actual provider settles.
    // Promise.race must not permit an unbounded offline command queue.
    const operation = Promise.resolve()
      .then(work)
      .finally(() => {
        this.pending--;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Candidate cache timeout')),
            25,
          );
        }),
      ]);
      this.failures = 0;
      return result;
    } catch (error) {
      if (++this.failures >= 5) {
        this.openUntil = this.clock() + 10000;
        this.failures = 0;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async get(
    key: string,
  ): Promise<readonly { id: string; score: number }[] | null> {
    if (!/^mkt:cand:v2:[a-f0-9]{64}$/.test(key)) return null;
    const raw = await this.run(() =>
      this.redis.hGet(this.namespace + ':bounded', key.slice(-64)),
    );
    if (!raw || Buffer.byteLength(raw) > 40000) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(',') !== 'expires,rows' ||
        !('expires' in parsed) ||
        typeof parsed.expires !== 'number' ||
        !Number.isFinite(parsed.expires) ||
        parsed.expires <= this.clock() ||
        parsed.expires > this.clock() + 120000 ||
        !('rows' in parsed) ||
        !Array.isArray(parsed.rows) ||
        parsed.rows.length > 300
      )
        return null;
      if (
        parsed.rows.some(
          (row) =>
            !row ||
            typeof row !== 'object' ||
            Object.keys(row).some((key) => key !== 'id' && key !== 'score') ||
            typeof row.id !== 'string' ||
            !pipelineUuid.test(row.id) ||
            typeof row.score !== 'number' ||
            !Number.isFinite(row.score),
        )
      )
        return null;
      if (new Set(parsed.rows.map((row) => row.id)).size !== parsed.rows.length)
        return null;
      return parsed.rows.map((row) => ({
        id: row.id as string,
        score: row.score as number,
      }));
    } catch {
      return null;
    }
  }
  async set(
    key: string,
    rows: readonly { id: string; score: number }[],
    ttlSeconds: number,
  ): Promise<void> {
    if (
      !/^mkt:cand:v2:[a-f0-9]{64}$/.test(key) ||
      !Array.isArray(rows) ||
      rows.length > 300 ||
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > 120 ||
      rows.some(
        (row) =>
          !row ||
          typeof row.id !== 'string' ||
          !pipelineUuid.test(row.id) ||
          !Number.isFinite(row.score),
      ) ||
      new Set(rows.map((row) => row.id)).size !== rows.length
    )
      throw new RangeError('Invalid candidate entry');
    const value = JSON.stringify({
      expires: this.clock() + ttlSeconds * 1000,
      rows: rows.map((row) => ({ id: row.id, score: row.score })),
    });
    if (Buffer.byteLength(value) > 40000) return;
    await this.run(() =>
      this.redis.eval(putScript, {
        keys: [this.namespace + ':bounded', this.namespace + ':bounded:expiry'],
        arguments: [
          key.slice(-64),
          value,
          String(this.clock()),
          String(this.clock() + ttlSeconds * 1000),
        ],
      }),
    );
  }
}
