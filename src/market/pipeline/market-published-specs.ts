import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { defaultPipelineSpecs } from './market-pipeline.defaults';
import {
  parsePipelineSpec,
  validatePipelineGraph,
} from './market-pipeline.schema';
import { PipelineSpec } from './market-pipeline.types';

const PUBLISHED_TTL_MS = 30_000;
const FAILED_READ_RETRY_MS = 5_000;
const PUBLISHED_LIMIT = 64;

function overlay(
  defaults: readonly PipelineSpec[],
  published: readonly PipelineSpec[],
  candidate?: PipelineSpec,
): PipelineSpec[] {
  const byKey = new Map<string, PipelineSpec>();
  for (const spec of defaults) byKey.set(spec.key, spec);
  for (const spec of published) byKey.set(spec.key, spec);
  if (candidate) byKey.set(candidate.key, candidate);
  return [...byKey.values()];
}

/**
 * The set an admin write is checked against: code defaults, each overridden by
 * its published spec, plus an optional candidate. Throws on any invalid spec or
 * a broken fallback graph, so a publish can never strand another section.
 */
export function mergePipelineSpecsStrict(
  published: readonly unknown[],
  candidate?: PipelineSpec,
): PipelineSpec[] {
  const specs = overlay(
    defaultPipelineSpecs(),
    published.map((raw) => parsePipelineSpec(raw)),
    candidate,
  );
  validatePipelineGraph(specs);
  return specs;
}

/**
 * The set serving uses. Published specs were validated when they were
 * published; if a later deploy makes the combined graph invalid, serving falls
 * back to the code defaults rather than failing a shopper's request.
 */
export function servingPipelineSpecs(
  defaults: readonly PipelineSpec[],
  published: readonly PipelineSpec[],
): readonly PipelineSpec[] {
  if (!published.length) return defaults;
  const specs = overlay(defaults, published);
  try {
    validatePipelineGraph(specs);
    return specs;
  } catch {
    return defaults;
  }
}

/**
 * Published Market section specs, read with one tiny query and cached in this
 * process for 30 s. Concurrent callers share one read. A failed read keeps the
 * last good set (or none), so serving never fails on admin data. Admin writes
 * call `invalidate()`; other processes catch up within the TTL.
 */
@Injectable()
export class MarketPublishedSpecsService {
  private readonly logger = new Logger(MarketPublishedSpecsService.name);
  private cached: { expires: number; specs: readonly PipelineSpec[] } | null =
    null;
  private loading: {
    generation: number;
    promise: Promise<readonly PipelineSpec[]>;
  } | null = null;
  private generation = 0;

  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<readonly PipelineSpec[]> {
    if (this.cached && this.cached.expires > Date.now())
      return this.cached.specs;
    if (this.loading?.generation !== this.generation) {
      const generation = this.generation;
      const promise = this.load(generation).finally(() => {
        if (this.loading?.promise === promise) this.loading = null;
      });
      this.loading = { generation, promise };
    }
    return this.loading.promise;
  }

  /** Called after a publish, pause, resume, archive or restore commits. */
  invalidate(): void {
    this.generation += 1;
    this.cached = null;
  }

  private async load(generation: number): Promise<readonly PipelineSpec[]> {
    try {
      const rows = await this.prisma.marketSectionConfig.findMany({
        where: { publishedVersionId: { not: null } },
        select: { sectionKey: true, spec: true },
        orderBy: { sectionKey: 'asc' },
        take: PUBLISHED_LIMIT,
      });
      const specs: PipelineSpec[] = [];
      for (const row of rows) {
        try {
          specs.push(parsePipelineSpec(row.spec));
        } catch {
          this.logger.warn(
            `Published Market section ${row.sectionKey} no longer parses; serving its default.`,
          );
        }
      }
      const defaults = defaultPipelineSpecs();
      if (servingPipelineSpecs(defaults, specs) === defaults && specs.length)
        this.logger.warn(
          'Published Market sections form an invalid fallback graph; serving code defaults.',
        );
      this.store(generation, specs, PUBLISHED_TTL_MS);
      return specs;
    } catch (error) {
      this.logger.warn(
        `Published Market sections unavailable, keeping the last good set: ${
          error instanceof Error ? error.message : 'read failed'
        }`,
      );
      const stale = this.cached?.specs ?? [];
      this.store(generation, stale, FAILED_READ_RETRY_MS);
      return stale;
    }
  }

  private store(
    generation: number,
    specs: readonly PipelineSpec[],
    ttlMs: number,
  ): void {
    // A publish that landed while this read was in flight wins.
    if (generation !== this.generation) return;
    this.cached = { expires: Date.now() + ttlMs, specs };
  }
}
