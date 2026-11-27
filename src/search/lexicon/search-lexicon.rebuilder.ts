import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { MarketLexiconRebuilder } from '../../market/intelligence/market-intelligence.contracts';
import {
  buildSearchLexiconBlob,
  SearchLexiconCapacityError,
} from './search-lexicon-blob';
import {
  searchLexiconSourceSql,
  type SearchLexiconSourceRow,
} from './search-lexicon-source.sql';
import {
  SEARCH_LEXICON_CONFIG_KEY,
  SEARCH_LEXICON_LIMITS,
} from './search-lexicon.types';

/** Per-statement ceiling inside the worker's overall deadline. */
const SOURCE_STATEMENT_MS = 20_000;
const WRITE_STATEMENT_MS = 5_000;
const MIN_REMAINING_MS = 250;

export interface SearchLexiconRebuildResult {
  status: 'replaced' | 'superseded';
  version: string;
  entries: number;
  words: number;
  bytes: number;
  sourceAsOf: string;
}

/**
 * Worker-only rebuild. Reads one repeatable-read snapshot, validates and
 * serializes the whole lexicon in memory, then replaces the stored blob in one
 * statement. Any failure before that statement leaves the last good lexicon in
 * place; a newer stored snapshot is never overwritten by an older one.
 */
@Injectable()
export class SearchLexiconRebuilder implements MarketLexiconRebuilder {
  private readonly logger = new Logger(SearchLexiconRebuilder.name);

  constructor(private readonly prisma: PrismaService) {}

  async rebuild(input: { deadline: Date; maxRows: number }): Promise<void> {
    await this.rebuildLexicon(input);
  }

  async rebuildLexicon(input: {
    deadline: Date;
    maxRows: number;
  }): Promise<SearchLexiconRebuildResult> {
    const deadline = input?.deadline?.getTime();
    if (!Number.isFinite(deadline))
      throw new RangeError('Invalid lexicon rebuild deadline');
    if (
      !Number.isInteger(input.maxRows) ||
      input.maxRows < 1 ||
      input.maxRows > SEARCH_LEXICON_LIMITS.maxRows
    )
      throw new RangeError('Invalid lexicon rebuild row ceiling');
    const remaining = () => Math.floor(deadline - Date.now());
    const started = Date.now();
    try {
      const { rows, sourceAsOf } = await this.readSource(
        input.maxRows,
        remaining,
      );
      const blob = buildSearchLexiconBlob(rows, {
        sourceAsOf,
        builtAt: new Date(),
        maxRows: input.maxRows,
      });
      const serialized = JSON.stringify(blob);
      const bytes = Buffer.byteLength(serialized, 'utf8');
      if (bytes > SEARCH_LEXICON_LIMITS.maxBytes)
        throw new SearchLexiconCapacityError(
          'Serialized search lexicon exceeds its byte ceiling',
        );
      const replaced = await this.replace(
        serialized,
        blob.sourceAsOf,
        remaining,
      );
      const result: SearchLexiconRebuildResult = {
        status: replaced ? 'replaced' : 'superseded',
        version: blob.version,
        entries: blob.entries.length,
        words: blob.words.length,
        bytes,
        sourceAsOf: blob.sourceAsOf,
      };
      this.logger.log(
        JSON.stringify({
          event: 'search_lexicon_rebuild',
          ...result,
          truncatedWords: blob.truncatedWords,
          durationMs: Date.now() - started,
        }),
      );
      return result;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'search_lexicon_rebuild_failed',
          reason:
            error instanceof SearchLexiconCapacityError
              ? 'CAPACITY'
              : error instanceof RangeError
                ? 'DEADLINE'
                : 'DATABASE',
          durationMs: Date.now() - started,
        }),
      );
      throw error;
    }
  }

  private budget(remaining: () => number, ceiling: number): number {
    const left = remaining();
    if (left < MIN_REMAINING_MS)
      throw new RangeError('Lexicon rebuild deadline reached');
    return Math.min(ceiling, left);
  }

  private async readSource(maxRows: number, remaining: () => number) {
    const transactionMs = this.budget(remaining, SOURCE_STATEMENT_MS + 1_000);
    return this.prisma.$transaction(
      async (tx) => {
        const statementMs = this.budget(remaining, SOURCE_STATEMENT_MS);
        const clock = await tx.$queryRaw<Array<{ asOf: Date }>>(Prisma.sql`
          SELECT set_config('transaction_read_only','on',true),
            set_config('statement_timeout',${String(statementMs)}::text,true),
            set_config('lock_timeout','1000',true),
            date_trunc('milliseconds',statement_timestamp()) AS "asOf"`);
        const sourceAsOf = clock[0]?.asOf;
        if (
          !(sourceAsOf instanceof Date) ||
          !Number.isFinite(sourceAsOf.getTime())
        )
          throw new Error('Lexicon source clock unavailable');
        const rows = await tx.$queryRaw<SearchLexiconSourceRow[]>(
          searchLexiconSourceSql(sourceAsOf, maxRows),
        );
        this.budget(remaining, 1);
        return { rows, sourceAsOf };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: Math.min(2_000, transactionMs),
        timeout: transactionMs,
      },
    );
  }

  /** Compare-and-replace by source instant; malformed stored values are replaced. */
  private async replace(
    serialized: string,
    sourceAsOf: string,
    remaining: () => number,
  ): Promise<boolean> {
    const transactionMs = this.budget(remaining, WRITE_STATEMENT_MS + 1_000);
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT set_config('statement_timeout',${String(this.budget(remaining, WRITE_STATEMENT_MS))}::text,true),
            set_config('lock_timeout','2000',true)`);
        const written = await tx.$queryRaw<Array<{ key: string }>>(Prisma.sql`
          INSERT INTO system_config (key,value,description,"updatedAt")
          VALUES (${SEARCH_LEXICON_CONFIG_KEY},${serialized},'Search lexicon (worker managed)',clock_timestamp())
          ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,"updatedAt"=EXCLUDED."updatedAt"
          WHERE CASE WHEN system_config.value IS JSON OBJECT
            THEN COALESCE(system_config.value::jsonb->>'sourceAsOf','') < ${sourceAsOf}
            ELSE true END
          RETURNING key`);
        return written.length === 1;
      },
      { maxWait: Math.min(2_000, transactionMs), timeout: transactionMs },
    );
  }
}
