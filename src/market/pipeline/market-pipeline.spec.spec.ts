import { defaultPipelineSpecs } from './market-pipeline.defaults';
import {
  parsePipelineSpec,
  validatePipelineGraph,
} from './market-pipeline.schema';
import { PIPELINE_TEMPLATES } from './market-pipeline.registry';

describe('Market pipeline spec boundary', () => {
  const base = {
    key: 'fresh-drops',
    template: 'NEW_RELEASES',
    status: 'ACTIVE',
  };
  it('validates every code default and preserves the three migrated filter rails', () => {
    const specs = defaultPipelineSpecs();
    validatePipelineGraph(specs);
    expect(specs.find((spec) => spec.key === 'adire-casual')?.filters).toEqual({
      tags: ['adire'],
    });
    expect(specs.find((spec) => spec.key === 'ready-to-wear')?.filters).toEqual(
      { fulfilment: 'READY_TO_WEAR', inStockOnly: true },
    );
    expect(specs.find((spec) => spec.key === 'made-to-order')?.filters).toEqual(
      { fulfilment: 'MADE_TO_ORDER' },
    );
  });
  it.each([
    { expression: 'price * 2' },
    { experiment: { share: 0.5 } },
    { rolloutPercent: 50 },
    { template: '__proto__' },
    { rankingPolicy: 'trend' },
    { title: 'Picked for you' },
    { title: 'Hot pieces' },
    { capacity: { preview: 13 } },
    { capacity: { preview: 1, minItems: 2 } },
    { params: { candidateLimit: 301 } },
    { params: { explorationShare: 26 } },
    { params: { evidenceFloorActors: 4 } },
    { params: { lowStockThreshold: 4 } },
    { params: { weights: { popularity: 1 } } },
    { filters: { privateSql: 'true' } },
    { sorts: ['popular'] },
    { sorts: ['newest', 'newest'] },
    { schedule: { startsAt: 'tomorrow' } },
    {
      schedule: {
        startsAt: '2026-11-21T12:00:00.000Z',
        endsAt: '2026-11-20T12:00:00.000Z',
      },
    },
    { diversity: { allowRepeat: true } },
    { cache: { sharedTtlSeconds: 121 } },
  ])('rejects unsupported or misleading spec fields: %j', (patch) => {
    expect(() => parsePipelineSpec({ ...base, ...patch })).toThrow();
  });
  it('normalizes canonical filters through the existing parser', () => {
    expect(
      parsePipelineSpec({
        ...base,
        filters: { colors: [' RED ', 'red'], onSale: false },
      }).filters,
    ).toEqual({ colors: ['red'] });
  });
  it('rejects missing curated placement, unknown fallback, cycles and excessive depth', () => {
    expect(() =>
      parsePipelineSpec({ ...base, template: 'CURATED_LIST' }),
    ).toThrow();
    expect(() =>
      validatePipelineGraph([
        parsePipelineSpec({ ...base, fallback: ['missing'] }),
      ]),
    ).toThrow();
    const a = parsePipelineSpec({ ...base, key: 'a', fallback: ['b'] });
    const b = parsePipelineSpec({ ...base, key: 'b', fallback: ['a'] });
    expect(() => validatePipelineGraph([a, b])).toThrow();
    const chain = ['a', 'b', 'c', 'd'].map((key, index, keys) =>
      parsePipelineSpec({
        ...base,
        key,
        fallback: keys[index + 1] ? [keys[index + 1]] : [],
      }),
    );
    expect(() => validatePipelineGraph(chain)).toThrow();
  });
  it('has a closed template registry and no user-defined executable policies', () => {
    expect(Object.keys(PIPELINE_TEMPLATES)).toHaveLength(17);
    expect(() =>
      parsePipelineSpec({
        ...base,
        template: 'AFFINITY',
        audience: { guests: true },
      }),
    ).toThrow();
  });
  it.each([0, 1, 5, 7])(
    'uses one truthful exploration section for a complete small catalogue of %s',
    (count) => {
      const specs = defaultPipelineSpecs(count);
      expect(specs).toHaveLength(1);
      expect(specs[0].title).toBe('Explore the Market');
      expect(specs[0].capacity.minItems).toBe(1);
    },
  );
});
