import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  MarketPipelineService,
  MarketPipelinePageInput,
} from './pipeline/market-pipeline.service';
import {
  pipelineExposureKeys,
  writePipelineExposures,
} from './pipeline/market-pipeline.delivery';

/** Rows this process already recorded in their epoch. Bounded and self-expiring,
 * so repeat page views skip a write transaction that would insert nothing. */
export const MARKET_EXPOSURE_MEMO_LIMIT = 20000;

/** Delivery writes are global, bounded and outside every read-only capture. */
@Injectable()
export class MarketPipelineDeliveryService {
  private readonly logger = new Logger(MarketPipelineDeliveryService.name);
  private writes = 0;
  private readonly written = new Map<string, number>();
  constructor(
    private readonly pipeline: MarketPipelineService,
    private readonly prisma: PrismaService,
  ) {}

  private alreadyWritten(keys: readonly string[], now: number): boolean {
    return keys.every((key) => (this.written.get(key) ?? 0) > now);
  }

  private remember(keys: readonly string[], expiresAt: number, now: number) {
    for (const [key, expiry] of this.written)
      if (expiry <= now) this.written.delete(key);
    for (const key of keys) {
      this.written.delete(key);
      this.written.set(key, expiresAt);
    }
    // Map iteration is insertion order: evict the oldest entries first.
    for (const key of this.written.keys()) {
      if (this.written.size <= MARKET_EXPOSURE_MEMO_LIMIT) break;
      this.written.delete(key);
    }
  }

  async page(input: MarketPipelinePageInput & { readonly limit?: number }) {
    const prepared = await this.pipeline.preparePage({
      ...input,
      sectionLimit: input.limit ?? input.sectionLimit,
    });
    const remaining = () =>
      Math.floor(
        (prepared.context.deadline ?? performance.now()) - performance.now(),
      );
    let exposure: ReturnType<typeof pipelineExposureKeys>;
    try {
      exposure = pipelineExposureKeys(prepared.exposureReceipt);
    } catch {
      this.logger.warn({ event: 'market.pipeline.exposure_invalid' });
      return prepared.public;
    }
    if (!exposure.keys.length || this.alreadyWritten(exposure.keys, Date.now()))
      return prepared.public;
    // No unbounded write queue and no abandoned fire-and-forget promise. A
    // missing exposure never converts a completed public page into a failure.
    if (this.writes < 4 && remaining() > 10 && !input.signal?.aborted) {
      this.writes++;
      try {
        const maxWait = Math.min(50, Math.floor(remaining() / 2));
        const timeout = Math.min(200, Math.max(1, remaining() - maxWait));
        const committed = await this.prisma.$transaction(
          async (tx) => {
            if (remaining() <= 1 || input.signal?.aborted) return false;
            const transactionMs = Math.min(timeout, remaining());
            await tx.$queryRaw`SELECT set_config('statement_timeout',${String(transactionMs)}::text,true),set_config('lock_timeout',${String(Math.min(50, transactionMs))}::text,true),set_config('transaction_timeout',${String(transactionMs)}::text,true)`;
            if (remaining() <= 1 || input.signal?.aborted) return false;
            await writePipelineExposures(tx, prepared.exposureReceipt);
            return true;
          },
          { maxWait, timeout },
        );
        // Remember only after commit: a rolled-back write must be retried.
        if (committed)
          this.remember(exposure.keys, exposure.expiresAt, Date.now());
      } catch {
        this.logger.warn({ event: 'market.pipeline.exposure_unavailable' });
      } finally {
        this.writes--;
      }
    } else {
      // Expected under burst or a spent page budget; the next view retries.
      this.logger.debug({ event: 'market.pipeline.exposure_skipped' });
    }
    return prepared.public;
  }
}
