import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  MarketPipelineService,
  MarketPipelinePageInput,
} from './pipeline/market-pipeline.service';
import { writePipelineExposures } from './pipeline/market-pipeline.delivery';

/** Delivery writes are global, bounded and outside every read-only capture. */
@Injectable()
export class MarketPipelineDeliveryService {
  private readonly logger = new Logger(MarketPipelineDeliveryService.name);
  private writes = 0;
  constructor(
    private readonly pipeline: MarketPipelineService,
    private readonly prisma: PrismaService,
  ) {}
  async page(input: MarketPipelinePageInput & { readonly limit?: number }) {
    const prepared = await this.pipeline.preparePage({
      ...input,
      sectionLimit: input.limit ?? input.sectionLimit,
    });
    const remaining = () =>
      Math.floor(
        (prepared.context.deadline ?? performance.now()) - performance.now(),
      );
    // No unbounded write queue and no abandoned fire-and-forget promise. A
    // missing exposure never converts a completed public page into a failure.
    if (this.writes < 4 && remaining() > 10 && !input.signal?.aborted) {
      this.writes++;
      try {
        const maxWait = Math.min(50, Math.floor(remaining() / 2));
        const timeout = Math.min(200, Math.max(1, remaining() - maxWait));
        await this.prisma.$transaction(
          async (tx) => {
            if (remaining() <= 1 || input.signal?.aborted) return 0;
            const transactionMs = Math.min(timeout, remaining());
            await tx.$queryRaw`SELECT set_config('statement_timeout',${String(transactionMs)}::text,true),set_config('lock_timeout',${String(Math.min(50, transactionMs))}::text,true),set_config('transaction_timeout',${String(transactionMs)}::text,true)`;
            if (remaining() <= 1 || input.signal?.aborted) return 0;
            return writePipelineExposures(tx, prepared.exposureReceipt);
          },
          { maxWait, timeout },
        );
      } catch {
        this.logger.warn({ event: 'market.pipeline.exposure_unavailable' });
      } finally {
        this.writes--;
      }
    } else if (prepared.public.sections.length) {
      this.logger.warn({ event: 'market.pipeline.exposure_skipped' });
    }
    return prepared.public;
  }
}
