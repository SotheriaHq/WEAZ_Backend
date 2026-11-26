import { Logger } from '@nestjs/common';
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
  it('names invalid tokens in one warning per configured value, not per call', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const service = new MarketFlagsService();
    const env = { MARKET_PIPELINE_V2_SURFACES: 'HOME,CATALOGUE,catlog' };
    for (let call = 0; call < 5; call++) {
      expect(service.isEnabled('HOME', env)).toBe(false);
      expect(service.getConfig(env).invalidSurfaceConfiguration).toBe(true);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'market.flags.invalid_surface_configuration',
        variable: 'MARKET_PIPELINE_V2_SURFACES',
        effect: 'ALL_SURFACES_OFF',
        invalidTokens: ['CATALOGUE', 'CATLOG'],
      }),
    );
    service.getConfig({ MARKET_PIPELINE_V2_SURFACES: 'a'.repeat(257) });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'TOO_LONG', length: 257 }),
    );
    service.getConfig({ MARKET_PIPELINE_V2_SURFACES: 'HOME' });
    service.getConfig({});
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
