import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { parseSearchLexiconBlob } from './search-lexicon-blob';
import { SearchLexiconIndex } from './search-lexicon.index';
import {
  SEARCH_LEXICON_CONFIG_KEY,
  SEARCH_LEXICON_LIMITS,
} from './search-lexicon.types';

interface LoadedLexicon {
  readonly index: SearchLexiconIndex;
  readonly sourceAsOf: number;
}

/**
 * Request-side view of the worker-built lexicon. One read per reload interval
 * is shared by every request; a failed or malformed read keeps the last good
 * lexicon, and a lexicon older than its age limit is not used at all, so
 * parsing degrades to plain text search instead of stale vocabulary.
 */
@Injectable()
export class SearchLexiconReader {
  private readonly logger = new Logger(SearchLexiconReader.name);
  private current: LoadedLexicon | null = null;
  private checkedAt = Number.NEGATIVE_INFINITY;
  private loading: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async index(now = Date.now()): Promise<SearchLexiconIndex | null> {
    if (now - this.checkedAt >= SEARCH_LEXICON_LIMITS.reloadMs) {
      this.loading ??= this.load(now).finally(() => {
        this.loading = null;
      });
      await this.loading;
    }
    const current = this.current;
    return current && now - current.sourceAsOf <= SEARCH_LEXICON_LIMITS.maxAgeMs
      ? current.index
      : null;
  }

  private async load(now: number): Promise<void> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ value: string | null }>>(
        Prisma.sql`SELECT value FROM system_config WHERE key=${SEARCH_LEXICON_CONFIG_KEY} LIMIT 1`,
      );
      const blob = parseSearchLexiconBlob(rows[0]?.value);
      if (!blob) {
        if (rows.length)
          this.logger.warn(
            JSON.stringify({ event: 'search_lexicon_unreadable' }),
          );
        return;
      }
      if (this.current?.index.version !== blob.version)
        this.current = {
          index: new SearchLexiconIndex(blob),
          sourceAsOf: Date.parse(blob.sourceAsOf),
        };
    } catch {
      // A database blip keeps the last good lexicon for another interval.
      this.logger.warn(JSON.stringify({ event: 'search_lexicon_load_failed' }));
    } finally {
      this.checkedAt = now;
    }
  }
}
