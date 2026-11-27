import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PIPELINE_TEMPLATES } from 'src/market/pipeline/market-pipeline.registry';
import { parsePipelineSpec } from 'src/market/pipeline/market-pipeline.schema';
import { AdminMarketSectionLifecycleService } from './admin-market-section-lifecycle.service';
import {
  carriedColumns,
  derivePresentation,
  mergeSectionSpecs,
  presentationColumns,
  summarisePreview,
} from './market-section-lifecycle';

describe('market section lifecycle helpers', () => {
  it('derives a classic presentation that moves the classic rail with the spec', () => {
    const spec = parsePipelineSpec({
      key: 'fresh-drops',
      template: 'NEW_RELEASES',
      title: 'Latest drops',
      status: 'PAUSED',
      placement: { order: 3 },
      schedule: { startsAt: '2026-12-01T00:00:00.000Z' },
    });
    const presentation = derivePresentation(
      spec,
      carriedColumns('fresh-drops', null),
    );

    expect(presentation).toEqual(
      expect.objectContaining({
        sectionKey: 'fresh-drops',
        title: 'Latest drops',
        enabled: false,
        status: 'PAUSED',
        displayOrder: 3,
        previewItemLimit: spec.capacity.preview,
        detailPageLimit: spec.capacity.page,
        minimumItems: spec.capacity.minItems,
        startsAt: '2026-12-01T00:00:00.000Z',
        endsAt: null,
      }),
    );
    // Columns the spec does not own come from the classic code default.
    expect(presentation.viewAllEnabled).toBe(true);
    expect(presentation.fallbackMode).toBe('CODE_DEFAULTS');
  });

  it('keeps a V2-only key hidden from the classic Market', () => {
    const spec = parsePipelineSpec({
      key: 'adire-casual',
      template: 'CATALOG_FILTER',
      title: 'Adire casual',
      status: 'ACTIVE',
    });
    const presentation = derivePresentation(
      spec,
      carriedColumns('adire-casual', null),
    );

    expect(presentation.enabled).toBe(false);
    expect(presentation.status).toBe('DRAFT');
  });

  it('writes JSON null metadata and real dates to the row', () => {
    const spec = parsePipelineSpec({
      key: 'fresh-drops',
      template: 'NEW_RELEASES',
      schedule: { endsAt: '2027-01-01T00:00:00.000Z' },
    });
    const columns = presentationColumns(
      derivePresentation(spec, carriedColumns('fresh-drops', null)),
    );

    expect(columns.metadata).toBe(Prisma.JsonNull);
    expect(columns.endsAt).toEqual(new Date('2027-01-01T00:00:00.000Z'));
    expect(columns.startsAt).toBeNull();
  });

  it('summarises a brand or category source as having no product list', () => {
    const summary = summarisePreview({
      kind: 'legacy',
      section: {
        title: 'New designers to watch',
        subtitle: null,
        template: 'NEW_DESIGNERS',
        metadata: {
          fallbackUsed: true,
          fallbackReason: 'too_few_candidates',
          candidateCount: 0,
          minItems: 2,
        },
      },
    });

    expect(summary.productList).toBe(false);
    expect(summary.items).toEqual([]);
    expect(summary.fallbackReason).toBe('too_few_candidates');
  });

  it('overrides a default by key and rejects a broken fallback graph', () => {
    const override = parsePipelineSpec({
      key: 'fresh-drops',
      template: 'NEW_RELEASES',
      title: 'Latest drops',
      status: 'ACTIVE',
    });
    const merged = mergeSectionSpecs([], override);
    expect(merged.filter((spec) => spec.key === 'fresh-drops')).toEqual([
      override,
    ]);

    const broken = parsePipelineSpec({
      key: 'adire-casual',
      template: 'CATALOG_FILTER',
      title: 'Adire casual',
      status: 'ACTIVE',
      fallback: ['not-a-section'],
    });
    expect(() => mergeSectionSpecs([], broken)).toThrow();
  });
});

describe('AdminMarketSectionLifecycleService', () => {
  const draftSpec = parsePipelineSpec({
    key: 'fresh-drops',
    template: 'NEW_RELEASES',
    title: 'Latest drops',
    status: 'PAUSED',
  });

  const createService = (draftDefinition: unknown) => {
    const prisma = {
      marketSectionConfig: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            draftDefinition === undefined
              ? null
              : { draftDefinition, draftRevision: 4 },
          ),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const pipeline = {
      getSection: jest.fn().mockResolvedValue({
        kind: 'catalogue',
        section: {
          title: 'Latest drops',
          subtitle: null,
          template: 'NEW_RELEASES',
          metadata: {
            fallbackUsed: false,
            fallbackReason: null,
            candidateCount: 1,
            minItems: 2,
          },
        },
        data: {
          items: [
            {
              id: 'p1',
              title: 'Adire wrap',
              entityType: 'PRODUCT',
              media: { url: 'u', thumbnailUrl: 't', fileId: 'f1' },
              price: { effectiveAmount: 5000, currency: 'NGN' },
            },
          ],
        },
      }),
    };
    const service = new AdminMarketSectionLifecycleService(
      prisma as any,
      {} as any,
      {} as any,
      pipeline as any,
    );
    return { service, pipeline, prisma };
  };

  it('previews the draft as a live guest would see it, whatever its status', async () => {
    const { service, pipeline } = createService({
      spec: draftSpec,
      presentation: {},
    });

    const preview = await service.preview('fresh-drops');

    expect(preview).toEqual(
      expect.objectContaining({ draftRevision: 4, viewer: 'guest' }),
    );
    // The editor gets one stable summary, not the internal pipeline result.
    expect(preview.preview).toEqual({
      title: 'Latest drops',
      subtitle: null,
      template: 'NEW_RELEASES',
      productList: true,
      fallbackUsed: false,
      fallbackReason: null,
      candidateCount: 1,
      minItems: 2,
      items: [
        {
          id: 'p1',
          title: 'Adire wrap',
          entityType: 'PRODUCT',
          imageUrl: 't',
          fileId: 'f1',
          price: 5000,
          currency: 'NGN',
        },
      ],
    });
    const call = pipeline.getSection.mock.calls[0][0];
    expect(call.key).toBe('fresh-drops');
    expect(call.viewer).toEqual({});
    const candidate = call.specs.find(
      (spec: { key: string }) => spec.key === 'fresh-drops',
    );
    expect(candidate).toEqual(
      expect.objectContaining({ title: 'Latest drops', status: 'ACTIVE' }),
    );
  });

  it('asks for a draft before previewing', async () => {
    const { service } = createService(null);

    await expect(service.preview('fresh-drops')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a malformed section key before any read', async () => {
    const { service, prisma } = createService(undefined);

    await expect(service.preview('Bad Key!')).rejects.toThrow(
      'Invalid section key',
    );
    expect(prisma.marketSectionConfig.findUnique).not.toHaveBeenCalled();
  });

  it('lists every registered template', () => {
    const { service } = createService(undefined);

    expect(service.listTemplates().map((item) => item.template)).toEqual(
      Object.keys(PIPELINE_TEMPLATES),
    );
  });
});
