import { SearchCoreService } from './search-core.service';
import { SEARCH_RANKING_TIERS } from './search-match.types';

describe('SearchCoreService', () => {
  const core = new SearchCoreService();

  it('normalizes display queries safely while preserving useful words', () => {
    const analysis = core.analyzeQuery('  @Avery-Cotour  ');

    expect(analysis.rawQuery).toBe('@Avery-Cotour');
    expect(analysis.mode).toBe('profile');
    expect(analysis.normalizedQuery).toBe('avery cotour');
    expect(analysis.tokens).toEqual(['avery', 'cotour']);
    expect(analysis.forcedTypes).toEqual(['profile']);
  });

  it('extracts distinctive tokens for multi-word identity queries', () => {
    const analysis = core.analyzeQuery('avery cotour');

    expect(analysis.tokens).toEqual(['avery', 'cotour']);
    expect(analysis.distinctiveTokens).toEqual(['avery', 'cotour']);
    expect(analysis.commerceGateTokens).toEqual(['avery', 'cotour']);
    expect(analysis.intent).toBe('identity');
  });

  it('keeps useful fashion qualifiers while ignoring generic commerce terms', () => {
    const analysis = core.analyzeQuery('male wears');

    expect(analysis.tokens).toEqual(['male', 'wears']);
    expect(analysis.distinctiveTokens).toEqual(['male']);
    expect(analysis.commerceGateTokens).toEqual(['male']);
  });

  it('strips tag prefixes and forces tag-only mode', () => {
    const analysis = core.analyzeQuery('/ankara');

    expect(analysis.mode).toBe('tag');
    expect(analysis.normalizedQuery).toBe('ankara');
    expect(analysis.forcedTypes).toEqual(['tag']);
    expect(analysis.intent).toBe('tag');
  });

  it('assigns identity tiers consistently', () => {
    expect(core.identityTier('Avery Cotour', 'avery cotour')).toEqual({
      tier: SEARCH_RANKING_TIERS.EXACT_IDENTITY,
      reason: 'exact-identity-name',
    });
    expect(core.identityTier('Avery Cotour', 'avery')).toEqual({
      tier: SEARCH_RANKING_TIERS.IDENTITY_PREFIX,
      reason: 'identity-prefix',
    });
    expect(core.exactHandleTier('averycotour', 'avery cotour')).toEqual({
      tier: SEARCH_RANKING_TIERS.EXACT_IDENTITY,
      reason: 'exact-handle',
    });
  });

  it('detects matched tokens for additive result metadata', () => {
    expect(
      core.matchedTokens(
        ['avery', 'cotour'],
        'Jaff View Cotour',
        'QA Runtime Market Piece',
      ),
    ).toEqual(['cotour']);
  });
});
