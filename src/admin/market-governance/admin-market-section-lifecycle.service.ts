import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminAuditAction, MarketSectionConfig, Prisma } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  MARKET_SECTION_CODE_DEFAULTS,
  MarketGovernanceConfigService,
} from 'src/market/market-governance-config.service';
import { PIPELINE_TEMPLATES } from 'src/market/pipeline/market-pipeline.registry';
import { parsePipelineSpec } from 'src/market/pipeline/market-pipeline.schema';
import { MarketPipelineService } from 'src/market/pipeline/market-pipeline.service';
import { PipelineSpec } from 'src/market/pipeline/market-pipeline.types';
import { AdminAuditService } from '../services/admin-audit.service';
import {
  carriedColumns,
  derivePresentation,
  lockClassicRails,
  MarketSectionDraftDefinition,
  mergeSectionSpecs,
  presentationColumns,
  summarisePreview,
} from './market-section-lifecycle';

type Tx = Prisma.TransactionClient;
type LifecycleMode =
  | 'draft'
  | 'publish'
  | 'restore'
  | 'pause'
  | 'resume'
  | 'archive';

const SECTION_KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const DEFINITION_MAX_BYTES = 65536;
const VERSION_PAGE = 50;

const STATUS_CHANGES = {
  pause: { from: ['ACTIVE'], to: 'PAUSED' },
  resume: { from: ['PAUSED'], to: 'ACTIVE' },
  archive: { from: ['DRAFT', 'ACTIVE', 'PAUSED'], to: 'ARCHIVED' },
} as const satisfies Record<
  'pause' | 'resume' | 'archive',
  { from: readonly PipelineSpec['status'][]; to: PipelineSpec['status'] }
>;

function conflict(code: string, message: string): never {
  throw new ConflictException({ code, message });
}

/**
 * Draft, preview, publish and version history for Market section specs.
 * Every write runs in one transaction with its audit entry; the WP02 database
 * triggers are the final guard that the served row always equals an immutable
 * published snapshot.
 */
@Injectable()
export class AdminMarketSectionLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly governance: MarketGovernanceConfigService,
    private readonly pipeline: MarketPipelineService,
  ) {}

  listTemplates() {
    return Object.entries(PIPELINE_TEMPLATES).map(([template, definition]) => ({
      template,
      title: definition.title,
      policy: definition.policy,
      entityType: definition.entityType,
      sorts: [...definition.sorts],
      signedInOnly: definition.requiredHistoryHours > 0,
      regional: definition.regional,
    }));
  }

  async getLifecycle(sectionKey: string) {
    const key = this.key(sectionKey);
    const row = await this.prisma.marketSectionConfig.findUnique({
      where: { sectionKey: key },
      select: {
        sectionKey: true,
        draftDefinition: true,
        draftRevision: true,
        spec: true,
        specVersion: true,
        publishedVersion: {
          select: { version: true, draftRevision: true, publishedAt: true },
        },
      },
    });
    if (!row)
      return {
        sectionKey: key,
        draft: null,
        draftRevision: 0,
        published: null,
        publishedVersion: 0,
        hasUnpublishedDraft: false,
      };
    return {
      sectionKey: key,
      draft: row.draftDefinition,
      draftRevision: row.draftRevision,
      published: row.spec,
      publishedVersion: row.specVersion,
      publishedAt: row.publishedVersion?.publishedAt ?? null,
      hasUnpublishedDraft:
        row.draftDefinition !== null &&
        row.draftRevision !== (row.publishedVersion?.draftRevision ?? 0),
    };
  }

  async saveDraft(
    sectionKey: string,
    input: {
      spec: Record<string, unknown>;
      expectedRevision: number;
      reason?: string;
    },
    actorId: string,
    req: Request,
  ) {
    const key = this.key(sectionKey);
    if (input.spec.key !== undefined && input.spec.key !== key)
      throw new BadRequestException({
        code: 'INVALID_SECTION_SPEC',
        message: 'The section key cannot change.',
      });
    return this.prisma.$transaction(async (tx) => {
      const row = await this.lockOrCreate(tx, key, actorId);
      if (row.draftRevision !== input.expectedRevision)
        conflict('STALE_DRAFT', 'Someone saved this section first. Reload it.');
      const definition = this.buildDefinition(
        row,
        input.spec,
        await this.publishedSpecs(tx, key),
      );
      const saved = await this.writeDraft(tx, row, definition, actorId);
      await this.log(tx, actorId, req, key, 'draft', input.reason, {
        draftRevision: saved.draftRevision,
      });
      return {
        sectionKey: key,
        draftRevision: saved.draftRevision,
        draft: definition,
      };
    });
  }

  async preview(sectionKey: string) {
    const key = this.key(sectionKey);
    const row = await this.prisma.marketSectionConfig.findUnique({
      where: { sectionKey: key },
      select: { draftDefinition: true, draftRevision: true },
    });
    const draft =
      row?.draftDefinition as unknown as MarketSectionDraftDefinition | null;
    if (!row || !draft)
      throw new NotFoundException('Save a draft to preview it.');
    // Preview shows the draft as a live guest would see it, whatever its status.
    const candidate = parsePipelineSpec({ ...draft.spec, status: 'ACTIVE' });
    const specs = mergeSectionSpecs(
      await this.publishedSpecs(this.prisma, key),
      candidate,
    );
    const result = await this.pipeline.getSection({
      key,
      viewer: {},
      query: new URLSearchParams(),
      specs,
    });
    return {
      sectionKey: key,
      draftRevision: row.draftRevision,
      viewer: 'guest',
      preview: summarisePreview(result),
    };
  }

  async publish(
    sectionKey: string,
    input: { draftRevision: number; reason: string },
    actorId: string,
    req: Request,
  ) {
    const key = this.key(sectionKey);
    const reason = this.requiredReason(input.reason);
    return this.prisma.$transaction(async (tx) => {
      // Rails first, then the row: the same lock order as the classic PATCH.
      await lockClassicRails(tx);
      const row = await this.lock(tx, key);
      if (!row.draftDefinition)
        conflict('NO_DRAFT', 'Save a draft before publishing.');
      if (row.draftRevision !== input.draftRevision)
        conflict(
          'STALE_DRAFT',
          'This draft changed after you previewed it. Review it again.',
        );
      const draft =
        row.draftDefinition as unknown as MarketSectionDraftDefinition;
      if (draft.spec.version !== row.specVersion + 1)
        conflict(
          'DRAFT_OUTDATED',
          'A newer version was published. Save the draft again.',
        );
      const published = await this.publishDraft(
        tx,
        row,
        draft,
        reason,
        actorId,
        await this.publishedSpecs(tx, key),
      );
      await this.log(tx, actorId, req, key, 'publish', reason, {
        version: published.version,
        draftRevision: row.draftRevision,
      });
      return published;
    });
  }

  async changeStatus(
    sectionKey: string,
    change: keyof typeof STATUS_CHANGES,
    input: { reason: string },
    actorId: string,
    req: Request,
  ) {
    const key = this.key(sectionKey);
    const reason = this.requiredReason(input.reason);
    const rule = STATUS_CHANGES[change];
    return this.prisma.$transaction(async (tx) => {
      // Rails first, then the row: the same lock order as the classic PATCH.
      await lockClassicRails(tx);
      const row = await this.lockPublished(tx, key);
      const current = row.spec as unknown as PipelineSpec;
      if (!(rule.from as readonly string[]).includes(current.status))
        conflict(
          'INVALID_TRANSITION',
          `A ${current.status.toLowerCase()} section cannot ${change}.`,
        );
      return this.republish(
        tx,
        row,
        { ...current, status: rule.to },
        change,
        reason,
        actorId,
        req,
      );
    });
  }

  async listVersions(sectionKey: string) {
    const key = this.key(sectionKey);
    const row = await this.prisma.marketSectionConfig.findUnique({
      where: { sectionKey: key },
      select: { id: true },
    });
    if (!row) return { sectionKey: key, items: [] };
    const items = await this.prisma.marketSectionConfigVersion.findMany({
      where: { configId: row.id },
      orderBy: { version: 'desc' },
      take: VERSION_PAGE,
      select: {
        version: true,
        draftRevision: true,
        publishedAt: true,
        publishedById: true,
        reason: true,
        spec: true,
      },
    });
    return { sectionKey: key, items };
  }

  async restore(
    sectionKey: string,
    version: number,
    input: { reason: string },
    actorId: string,
    req: Request,
  ) {
    const key = this.key(sectionKey);
    const reason = this.requiredReason(input.reason);
    return this.prisma.$transaction(async (tx) => {
      // Rails first, then the row: the same lock order as the classic PATCH.
      await lockClassicRails(tx);
      const row = await this.lockPublished(tx, key);
      const source = await tx.marketSectionConfigVersion.findUnique({
        where: { configId_version: { configId: row.id, version } },
        select: { spec: true },
      });
      if (!source) throw new NotFoundException('That version does not exist.');
      return this.republish(
        tx,
        row,
        source.spec as unknown as PipelineSpec,
        'restore',
        reason,
        actorId,
        req,
        { restoredFrom: version },
      );
    });
  }

  /** Publish a new version derived from an existing spec (status change or restore). */
  private async republish(
    tx: Tx,
    row: MarketSectionConfig,
    spec: PipelineSpec,
    mode: LifecycleMode,
    reason: string,
    actorId: string,
    req: Request,
    extra: Record<string, unknown> = {},
  ) {
    const others = await this.publishedSpecs(tx, row.sectionKey);
    const definition = this.buildDefinition(
      row,
      spec as unknown as Record<string, unknown>,
      others,
    );
    const saved = await this.writeDraft(tx, row, definition, actorId);
    const published = await this.publishDraft(
      tx,
      saved,
      definition,
      reason,
      actorId,
      others,
    );
    await this.log(tx, actorId, req, row.sectionKey, mode, reason, {
      version: published.version,
      ...extra,
    });
    return published;
  }

  private buildDefinition(
    row: MarketSectionConfig,
    input: Record<string, unknown>,
    others: Prisma.JsonValue[],
  ): MarketSectionDraftDefinition {
    const spec = parsePipelineSpec({
      ...input,
      key: row.sectionKey,
      version: row.specVersion + 1,
    });
    // Early feedback: the draft must fit the set serving would see.
    mergeSectionSpecs(others, spec);
    const definition = {
      spec,
      presentation: derivePresentation(
        spec,
        carriedColumns(row.sectionKey, row),
      ),
    };
    if (Buffer.byteLength(JSON.stringify(definition)) > DEFINITION_MAX_BYTES)
      throw new BadRequestException({
        code: 'INVALID_SECTION_SPEC',
        message: 'This section configuration is too large.',
      });
    return definition;
  }

  private async writeDraft(
    tx: Tx,
    row: MarketSectionConfig,
    definition: MarketSectionDraftDefinition,
    actorId: string,
  ): Promise<MarketSectionConfig> {
    const { count } = await tx.marketSectionConfig.updateMany({
      where: { id: row.id, draftRevision: row.draftRevision },
      data: {
        draftDefinition: definition as unknown as Prisma.InputJsonValue,
        draftRevision: row.draftRevision + 1,
        updatedById: actorId,
      },
    });
    if (count !== 1)
      conflict('STALE_DRAFT', 'Someone saved this section first. Reload it.');
    return {
      ...row,
      draftDefinition: definition as unknown as Prisma.JsonValue,
      draftRevision: row.draftRevision + 1,
    };
  }

  private async publishDraft(
    tx: Tx,
    row: MarketSectionConfig,
    draft: MarketSectionDraftDefinition,
    reason: string,
    actorId: string,
    others: Prisma.JsonValue[],
  ) {
    // Re-validate the stored draft against today's parser and the live set.
    const spec = parsePipelineSpec(draft.spec);
    mergeSectionSpecs(others, spec);
    await this.assertClassicRailRemains(tx, row.sectionKey, draft);
    const version = await tx.marketSectionConfigVersion.create({
      data: {
        configId: row.id,
        version: row.specVersion + 1,
        draftRevision: row.draftRevision,
        spec: draft.spec as unknown as Prisma.InputJsonValue,
        presentation: draft.presentation as unknown as Prisma.InputJsonValue,
        publishedById: actorId,
        reason,
      },
      select: { id: true, version: true, publishedAt: true },
    });
    await tx.marketSectionConfig.update({
      where: { id: row.id },
      data: {
        ...presentationColumns(draft.presentation),
        publishedVersionId: version.id,
        specVersion: version.version,
        spec: draft.spec as unknown as Prisma.InputJsonValue,
        updatedById: actorId,
      },
    });
    return {
      sectionKey: row.sectionKey,
      version: version.version,
      publishedAt: version.publishedAt,
      status: spec.status,
    };
  }

  /**
   * Classic Market keeps at least one active rail, as the classic PATCH
   * requires. Any key counts: a V2 spec published on a custom classic row
   * hides it too. Reads inside the transaction, under `lockClassicRails`.
   */
  private async assertClassicRailRemains(
    tx: Tx,
    key: string,
    draft: MarketSectionDraftDefinition,
  ) {
    if (draft.presentation.enabled) return;
    const current = await this.governance.getSectionConfigsWithFallback(tx);
    const remaining = current.items.some(
      (config) =>
        config.sectionKey !== key &&
        config.enabled &&
        config.status === 'ACTIVE',
    );
    if (!remaining)
      throw new BadRequestException(
        'At least one active market section must remain enabled',
      );
  }

  private async publishedSpecs(
    client: Tx | PrismaService,
    exceptKey: string,
  ): Promise<Prisma.JsonValue[]> {
    const rows = await client.marketSectionConfig.findMany({
      // The projection trigger keeps `spec` set exactly when a version is published.
      where: {
        publishedVersionId: { not: null },
        sectionKey: { not: exceptKey },
      },
      select: { spec: true },
      take: 64,
    });
    return rows.map((row) => row.spec as Prisma.JsonValue);
  }

  private async lock(tx: Tx, key: string): Promise<MarketSectionConfig> {
    // Serialises draft, publish and restore per section.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "_id" AS id FROM "MarketSectionConfig"
      WHERE "sectionKey" = ${key} FOR UPDATE`;
    if (locked.length === 0)
      throw new NotFoundException('Market section not found');
    return tx.marketSectionConfig.findUniqueOrThrow({
      where: { sectionKey: key },
    });
  }

  private async lockPublished(
    tx: Tx,
    key: string,
  ): Promise<MarketSectionConfig> {
    const row = await this.lock(tx, key);
    if (!row.publishedVersionId || !row.spec)
      conflict('NOT_PUBLISHED', 'Publish this section first.');
    const published = await tx.marketSectionConfigVersion.findUniqueOrThrow({
      where: { id: row.publishedVersionId },
      select: { draftRevision: true },
    });
    if (published.draftRevision !== row.draftRevision)
      conflict(
        'UNPUBLISHED_DRAFT',
        'This section has an unpublished draft. Publish it or save the live version as the draft first.',
      );
    return row;
  }

  private async lockOrCreate(
    tx: Tx,
    key: string,
    actorId: string,
  ): Promise<MarketSectionConfig> {
    const existing = await tx.marketSectionConfig.findUnique({
      where: { sectionKey: key },
      select: { id: true },
    });
    if (!existing) {
      // A first draft must not change what either Market serves today.
      await tx.marketSectionConfig.createMany({
        data: [this.unpublishedRow(key, actorId)],
        skipDuplicates: true,
      });
    }
    return this.lock(tx, key);
  }

  private unpublishedRow(
    key: string,
    actorId: string,
  ): Prisma.MarketSectionConfigCreateManyInput {
    const classic = MARKET_SECTION_CODE_DEFAULTS.find(
      (config) => config.sectionKey === key,
    );
    if (classic) {
      // `source` is a read-model tag, not a column.
      const columns: Partial<typeof classic> = { ...classic };
      delete columns.source;
      return {
        ...(columns as Omit<typeof classic, 'source'>),
        metadata:
          classic.metadata === null
            ? Prisma.JsonNull
            : (classic.metadata as Prisma.InputJsonValue),
        createdById: actorId,
        updatedById: actorId,
      };
    }
    return {
      sectionKey: key,
      title: key,
      enabled: false,
      status: 'DRAFT',
      createdById: actorId,
      updatedById: actorId,
    };
  }

  private async log(
    tx: Tx,
    actorId: string,
    req: Request,
    key: string,
    mode: LifecycleMode,
    reason: string | undefined,
    details: Record<string, unknown>,
  ) {
    await this.audit.logInTransaction(
      tx,
      {
        actorUserId: actorId,
        action: AdminAuditAction.ADMIN_MARKET_SECTION_CONFIG_UPDATE,
        targetType: 'MarketSectionConfig',
        targetId: key,
        metadata: { mode, reason: reason?.trim() || null, ...details },
      },
      req,
    );
  }

  private key(value: string): string {
    const key = value?.trim().toLowerCase();
    if (!key || !SECTION_KEY.test(key))
      throw new BadRequestException('Invalid section key');
    return key;
  }

  private requiredReason(value: string | undefined): string {
    const reason = value?.trim();
    if (!reason)
      throw new BadRequestException('Give a reason for this change.');
    return reason;
  }
}
