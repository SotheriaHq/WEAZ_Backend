import { MarketFlagsService, MARKET_V2_SURFACES } from './market-flags.service';

describe('explicit Market V2 surface rollout', () => {
  const flags = new MarketFlagsService();
  it('defaults every new surface off', () => {
    expect(flags.getConfig({})).toEqual({
      pipelineV2Surfaces: [],
      invalidSurfaceConfiguration: false,
    });
    for (const surface of MARKET_V2_SURFACES)
      expect(flags.isEnabled(surface, {})).toBe(false);
  });
  it('enables only selected surfaces without a broad master switch', () => {
    const env = { MARKET_PIPELINE_V2_SURFACES: ' catalog,HOME,catalog ' };
    expect(flags.getConfig(env).pipelineV2Surfaces).toEqual([
      'CATALOG',
      'HOME',
    ]);
    expect(flags.isEnabled('HOME', env)).toBe(true);
    expect(flags.isEnabled('SEE_ALL', env)).toBe(false);
    expect(Object.isFrozen(flags.getConfig(env).pipelineV2Surfaces)).toBe(true);
  });
  it.each([
    'ALL',
    'HOME,TYPO',
    'HOME,,CATALOG',
    'HOME,',
    'true',
    '*',
    'a'.repeat(257),
  ])('fails the rollout closed for malformed configuration: %s', (value) => {
    expect(flags.getConfig({ MARKET_PIPELINE_V2_SURFACES: value })).toEqual({
      pipelineV2Surfaces: [],
      invalidSurfaceConfiguration: true,
    });
  });
});
