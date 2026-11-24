import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MARKET_FEATURE_CHUNK,
  MARKET_FEATURE_PARAMETERS,
  MARKET_FEATURE_STATE_KEY,
  MARKET_MAX_PRODUCTS,
  MARKET_RAW_RETENTION_MS,
  MARKET_WRITE_CHUNK,
  MarketIntelligenceResult,
  parseMarketSalesCoverage,
  MARKET_SNAPSHOT_ROW_ALLOWANCE_BYTES,
  marketSnapshotStorageBudget,
  MarketSnapshotAdmission,
  marketSnapshotAdmissionReason,
} from './market-intelligence.contracts';
import {
  MARKET_RETENTION_CLASSES,
  marketFeatureRefreshSql,
  marketPriceSweepSql,
  marketRetentionDeleteSql,
  marketRetentionRemainingSql,
  marketSnapshotCopySql,
  marketSnapshotReadSummarySql,
} from './market-intelligence.sql';

type Tx = Prisma.TransactionClient;
const SQL_BUDGET_MS = 3_000;
const JOB_BUDGET_MS = 90_000;
const LOCK_NAMESPACE = 72_304;

/** These jobs never consume identity rows to manufacture unavailable histories. */
@Injectable()
export class MarketIntelligenceService {
  constructor(private readonly prisma: PrismaService) {}

  private async transaction<T>(
    run: (tx: Tx) => Promise<T>,
    timeout = JOB_BUDGET_MS,
  ): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout',${String(SQL_BUDGET_MS)},true),
        set_config('lock_timeout','500',true),set_config('idle_in_transaction_session_timeout','10000',true)`;
        return run(tx);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 2_000,
        timeout,
      },
    );
  }

  private async lock(tx: Tx, slot: number): Promise<boolean> {
    const [row] = await tx.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${LOCK_NAMESPACE}::int,${slot}::int) AS acquired`;
    return row.acquired;
  }

  private async clock(tx: Tx): Promise<Date> {
    const [row] = await tx.$queryRaw<{ now: Date }[]>`
      SELECT date_trunc('milliseconds',statement_timestamp()) AS now`;
    return row.now;
  }

  private async watermark(tx: Tx, key: string, value: object): Promise<void> {
    // Progress commits with the result, never before it. A crash is safe to retry.
    await tx.$executeRaw`INSERT INTO system_config (key,value,"updatedAt")
      VALUES (${key},${JSON.stringify(value)},statement_timestamp())
      ON CONFLICT (key) DO UPDATE SET value=excluded.value,"updatedAt"=excluded."updatedAt"`;
  }

  async refreshFeatures(): Promise<MarketIntelligenceResult> {
    return this.transaction(async (tx) => {
      if (!(await this.lock(tx, 1))) return { status: 'skipped', rows: 0 };
      const sourceAsOf = await this.clock(tx);
      const [salesSource] = await tx.$queryRaw<{ value: string }[]>`
        SELECT value FROM system_config WHERE key='market.sales.source.coverage'`;
      const sales = parseMarketSalesCoverage(
        salesSource?.value ?? null,
        sourceAsOf,
      );
      let after: string | null = null;
      let rows = 0;
      for (
        let page = 0;
        page <= MARKET_MAX_PRODUCTS / MARKET_FEATURE_CHUNK;
        page++
      ) {
        const batch: { id: string }[] = await tx.$queryRaw(
          marketFeatureRefreshSql(sourceAsOf, after, sales),
        );
        rows += batch.length;
        if (rows > MARKET_MAX_PRODUCTS)
          throw new Error('Market feature product budget exceeded');
        if (batch.length < MARKET_FEATURE_CHUNK) {
          await this.watermark(tx, 'market.features.watermark', {
            sourceAsOf: sourceAsOf.toISOString(),
            rows,
          });
          return {
            status: 'completed',
            rows,
            sourceAsOf: sourceAsOf.toISOString(),
          };
        }
        after = batch[batch.length - 1].id;
      }
      throw new Error('Market feature page budget exceeded');
    });
  }

  async publishSnapshot(): Promise<MarketIntelligenceResult> {
    return this.transaction(async (tx) => {
      if (!(await this.lock(tx, 2))) return { status: 'skipped', rows: 0 };
      const now = await this.clock(tx);
      const epochStart = new Date(
        Math.floor(now.getTime() / 21_600_000) * 21_600_000,
      );
      const epochEnd = new Date(epochStart.getTime() + 21_600_000);
      const cleanupAfter = new Date(epochEnd.getTime() + 3_600_000);
      const id = randomUUID();
      const parameters = JSON.stringify(MARKET_FEATURE_PARAMETERS);
      await tx.$executeRaw`INSERT INTO market_feature_state (key,parameters,"updatedAt")
        VALUES (${MARKET_FEATURE_STATE_KEY},${parameters}::jsonb,${now}::timestamptz)
        ON CONFLICT (key) DO NOTHING`;
      const [state] = await tx.$queryRaw<
        { generation: bigint; valid: boolean }[]
      >`
        SELECT generation,parameters=${parameters}::jsonb AS valid FROM market_feature_state
        WHERE key=${MARKET_FEATURE_STATE_KEY} FOR UPDATE`;
      if (!state.valid)
        throw new Error('Market feature state parameters do not match');
      const budget = marketSnapshotStorageBudget();
      if (budget === null)
        return { status: 'backlog', rows: 0, reason: 'INVALID_STORAGE_BUDGET' };
      const [admission] = await tx.$queryRaw<MarketSnapshotAdmission[]>`SELECT
        (SELECT count(*)::int FROM market_feature_epochs WHERE "stateKey"=${MARKET_FEATURE_STATE_KEY}) AS retained,
        (SELECT count(*)::int FROM market_feature_epochs WHERE "stateKey"=${MARKET_FEATURE_STATE_KEY}
          AND "epochStart"=${epochStart}::timestamptz) AS bucket,
        (SELECT e."readyAt" FROM market_feature_state s JOIN market_feature_epochs e ON e.id=s."currentEpochId"
          WHERE s.key=${MARKET_FEATURE_STATE_KEY} AND e."epochStart"=${epochStart}::timestamptz) AS "readyAt",
        live.count AS "liveRows",live.oldest AS "liveOldest",live.latest AS "liveLatest",
        frozen.count AS "frozenRows",frozen.oldest AS "frozenOldest",frozen.latest AS "frozenLatest"
      FROM (SELECT count(*)::int,min("sourceAsOf") AS oldest,max("computedAt") AS latest FROM market_item_features
        WHERE "featureSchemaVersion"=${MARKET_FEATURE_PARAMETERS.featureSchemaVersion}
          AND "policyVersion"=${MARKET_FEATURE_PARAMETERS.policyVersion}) live
      CROSS JOIN (SELECT count(*)::int,min(f."sourceAsOf") AS oldest,max(f."sourceComputedAt") AS latest
        FROM market_feature_state s JOIN market_item_feature_snapshots f ON f."epochId"=s."currentEpochId"
        WHERE s.key=${MARKET_FEATURE_STATE_KEY}) frozen`;
      const decision = marketSnapshotAdmissionReason(admission, now);
      if (decision) return { ...decision, rows: 0 };
      const [storage] = await tx.$queryRaw<
        { retainedBytes: bigint; generationBytes: bigint }[]
      >`
        SELECT (SELECT coalesce(sum(octet_length(f.coverage::text)+${MARKET_SNAPSHOT_ROW_ALLOWANCE_BYTES}),0)::bigint
          FROM market_item_feature_snapshots f JOIN market_feature_epochs e ON e.id=f."epochId"
          WHERE e."stateKey"=${MARKET_FEATURE_STATE_KEY}) AS "retainedBytes",
        (SELECT coalesce(sum(octet_length(coverage::text)+${MARKET_SNAPSHOT_ROW_ALLOWANCE_BYTES}),0)::bigint
          FROM market_item_features WHERE "featureSchemaVersion"=${MARKET_FEATURE_PARAMETERS.featureSchemaVersion}
            AND "policyVersion"=${MARKET_FEATURE_PARAMETERS.policyVersion}) AS "generationBytes"`;
      if (storage.retainedBytes + storage.generationBytes > BigInt(budget))
        return {
          status: 'backlog',
          rows: 0,
          reason: 'STORAGE_BUDGET',
          retainedBytes: Number(storage.retainedBytes),
        };
      const generation = state.generation + 1n;
      await tx.$executeRaw`INSERT INTO market_feature_epochs
        (id,"stateKey",generation,"epochStart","epochEnd","sourceAsOf","acceptUntil",parameters,"cleanupAfter")
        VALUES (${id}::uuid,${MARKET_FEATURE_STATE_KEY},${generation},${epochStart}::timestamptz,
          ${epochEnd}::timestamptz,${now}::timestamptz,${epochEnd}::timestamptz,${parameters}::jsonb,${cleanupAfter}::timestamptz)`;
      // G3 assigns its authoritative source instant when the transaction claims ownership.
      await tx.$executeRaw`UPDATE market_feature_epochs SET "writerXid"=pg_current_xact_id() WHERE id=${id}::uuid`;
      let rows = 0;
      let after: string | null = null;
      let finished = false;
      for (
        let page = 0;
        page <= MARKET_MAX_PRODUCTS / MARKET_WRITE_CHUNK;
        page++
      ) {
        const batch: { id: string }[] = await tx.$queryRaw(
          marketSnapshotCopySql(id, after),
        );
        rows += batch.length;
        if (rows > MARKET_MAX_PRODUCTS)
          throw new Error('Market snapshot product budget exceeded');
        if (batch.length < MARKET_WRITE_CHUNK) {
          finished = true;
          break;
        }
        // RETURNING does not guarantee row order.
        after = batch.reduce(
          (maximum, row) => (row.id > maximum ? row.id : maximum),
          batch[0].id,
        );
      }
      if (!finished) throw new Error('Market snapshot page budget exceeded');
      const [readSummary] = await tx.$queryRaw<
        Array<{
          sourceAsOf: Date;
          acceptUntil: Date;
          popularity: boolean;
          trend: boolean;
          quality: boolean;
        }>
      >(marketSnapshotReadSummarySql(id));
      if (!readSummary)
        throw new Error('Market snapshot read summary unavailable');
      const summary = {
        version: 1,
        epochId: id,
        generation: generation.toString(),
        sourceAsOf: readSummary.sourceAsOf.toISOString(),
        acceptUntil: readSummary.acceptUntil.toISOString(),
        rows,
        complete: {
          popularity: readSummary.popularity,
          trend: readSummary.trend,
          quality: readSummary.quality,
        },
      };
      // The summary and READY pointer become visible atomically. Historical
      // parameters/immutability guards remain unchanged.
      await this.watermark(tx, 'market.features.snapshot', {
        epochId: id,
        generation: generation.toString(),
        rows,
        readSummary: summary,
      });
      await tx.$executeRaw`UPDATE market_feature_epochs SET status='READY',"rowCount"=${rows} WHERE id=${id}::uuid`;
      await tx.$executeRaw`UPDATE market_feature_state SET generation=${generation},"currentEpochId"=${id}::uuid,
        "updatedAt"=statement_timestamp() WHERE key=${MARKET_FEATURE_STATE_KEY}`;
      return { status: 'completed', rows, epochId: id };
    });
  }

  async sweepPrices(): Promise<MarketIntelligenceResult> {
    let rows = 0;
    const deadline = Date.now() + 30_000;
    // Each chunk commits independently; an interrupted sweep resumes via due boundaries.
    for (let chunk = 0; chunk < 20 && Date.now() < deadline; chunk++) {
      const count = await this.transaction(async (tx) => {
        if (!(await this.lock(tx, 3))) return -1;
        return tx.$executeRaw(marketPriceSweepSql(await this.clock(tx)));
      }, 10_000);
      if (count === -1) return { status: 'skipped', rows };
      rows += count;
      if (count < MARKET_WRITE_CHUNK) return { status: 'completed', rows };
    }
    return { status: 'backlog', rows };
  }

  async cleanupPrivacy(): Promise<MarketIntelligenceResult> {
    const deadline = Date.now() + 30_000;
    const pending = new Set(MARKET_RETENTION_CLASSES);
    let rows = 0;
    // Round robin prevents a large old event table starving profile/aggregate erasure.
    for (
      let pass = 0;
      pass < 8 && pending.size && Date.now() < deadline;
      pass++
    ) {
      for (const kind of [...pending]) {
        if (Date.now() >= deadline) break;
        const count = await this.transaction(async (tx) => {
          if (
            !(await this.lock(tx, 10 + MARKET_RETENTION_CLASSES.indexOf(kind)))
          )
            return { count: 0, remaining: true };
          const now = await this.clock(tx);
          const cutoff = new Date(now.getTime() - MARKET_RAW_RETENTION_MS);
          const count = await tx.$executeRaw(
            marketRetentionDeleteSql(kind, cutoff),
          );
          // SKIP LOCKED may return fewer rows while expired rows remain locked.
          const [evidence] =
            count < MARKET_WRITE_CHUNK
              ? await tx.$queryRaw<{ remaining: boolean }[]>(
                  marketRetentionRemainingSql(kind, cutoff),
                )
              : [{ remaining: true }];
          return { count, remaining: evidence.remaining };
        }, 10_000);
        rows += count.count;
        if (!count.remaining) pending.delete(kind);
      }
      if (pending.size && Date.now() < deadline)
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const status = pending.size ? 'backlog' : 'completed';
    await this.transaction(
      (tx) =>
        this.watermark(tx, 'market.privacy.cleanup', {
          completedAt: new Date().toISOString(),
          rows,
          status,
          pendingClasses: [...pending],
        }),
      10_000,
    );
    return { status, rows };
  }

  async cleanupEpochs(): Promise<MarketIntelligenceResult> {
    return this.transaction(async (tx) => {
      if (!(await this.lock(tx, 4))) return { status: 'skipped', rows: 0 };
      const now = await this.clock(tx);
      // Epochs have bounded product fanout; delete snapshots explicitly in chunks
      // before deleting their manifests. Never cascade a whole catalogue in one DELETE.
      const [expired] = await tx.$queryRaw<{ id: string }[]>`
        SELECT e.id FROM market_feature_epochs e WHERE e."cleanupAfter"<=${now}::timestamptz
          AND NOT EXISTS(SELECT 1 FROM market_feature_state s WHERE s."currentEpochId"=e.id)
        ORDER BY e."cleanupAfter",e.id LIMIT 1 FOR UPDATE SKIP LOCKED`;
      let rows = 0;
      if (expired) {
        rows = await tx.$executeRaw`WITH batch AS MATERIALIZED (
          SELECT "productId" FROM market_item_feature_snapshots WHERE "epochId"=${expired.id}::uuid
          ORDER BY "productId" LIMIT ${MARKET_WRITE_CHUNK})
          DELETE FROM market_item_feature_snapshots f USING batch b
          WHERE f."epochId"=${expired.id}::uuid AND f."productId"=b."productId"`;
        // The FK uses SET NULL for retained nonpersonal tenure rows. Detach a
        // bounded page explicitly so manifest deletion cannot fan out unboundedly.
        await tx.$executeRaw`WITH batch AS MATERIALIZED (
          SELECT "sectionKey","productId",epoch FROM market_section_exposure
          WHERE "epochId"=${expired.id}::uuid ORDER BY epoch,"sectionKey","productId" LIMIT ${MARKET_WRITE_CHUNK})
          UPDATE market_section_exposure e SET "epochId"=NULL FROM batch b
          WHERE e."sectionKey"=b."sectionKey" AND e."productId"=b."productId" AND e.epoch=b.epoch`;
        await tx.$executeRaw`DELETE FROM market_feature_epochs WHERE id=${expired.id}::uuid
          AND NOT EXISTS(SELECT 1 FROM market_item_feature_snapshots WHERE "epochId"=${expired.id}::uuid)
          AND NOT EXISTS(SELECT 1 FROM market_section_exposure WHERE "epochId"=${expired.id}::uuid)`;
      }
      rows += await tx.$executeRaw`WITH batch AS MATERIALIZED (
        SELECT "sectionKey","productId",epoch FROM market_section_exposure
        WHERE epoch<${new Date(now.getTime() - 14 * 86_400_000)}::timestamptz
        ORDER BY epoch,"sectionKey","productId" LIMIT ${MARKET_WRITE_CHUNK})
        DELETE FROM market_section_exposure e USING batch b
        WHERE e."sectionKey"=b."sectionKey" AND e."productId"=b."productId" AND e.epoch=b.epoch`;
      return { status: expired ? 'backlog' : 'completed', rows };
    }, 10_000);
  }
}
