import { MarketSignalTargetType, MarketSignalType } from '@prisma/client';
import {
  buildContributionContextQuery,
  contributionBudgetCrossed,
  contributionContextRequired,
  contributionVelocityCrossed,
  decideMarketSignalContributions,
  EMPTY_MARKET_SIGNAL_CONTRIBUTION_CONTEXT,
  MARKET_SIGNAL_CONTRIBUTION_BUDGET,
  MARKET_SIGNAL_VELOCITY_EVENTS,
  MarketSignalContributionActor,
  MarketSignalContributionEvent,
  parseContributionContext,
} from './market-signal-contribution';

const PRODUCT = '7f1d3c1e-2b8a-4c55-9a43-0d2a7a9e6b11';
const OTHER = '0a9b4f3c-6c3e-4a51-8f0e-7d1b2c3d4e5f';

const user: MarketSignalContributionActor = {
  kind: 'USER',
  userId: 'b5b0f0a4-5d3a-4f68-9a3e-2f0b1c2d3e4f',
  anonymousSessionId: null,
  operator: false,
};
const guest: MarketSignalContributionActor = {
  kind: 'ANONYMOUS',
  userId: null,
  anonymousSessionId: 'device-1',
  operator: false,
};

const ev = (
  signalType: MarketSignalType,
  targetId = PRODUCT,
  targetType: MarketSignalTargetType = MarketSignalTargetType.PRODUCT,
): MarketSignalContributionEvent => ({ targetType, targetId, signalType });

const history = (
  entries: Array<[string, string, MarketSignalType, number, number]>,
  extra: Record<string, unknown> = {},
) =>
  parseContributionContext([
    { recentCount: 0, history: entries, ownedTargets: [], ...extra },
  ]);

describe('market signal contribution decisions', () => {
  it('never counts client claims of commerce or social actions', () => {
    const hard = [
      MarketSignalType.ADD_TO_CART,
      MarketSignalType.PURCHASE,
      MarketSignalType.WISHLIST,
      MarketSignalType.SAVE,
      MarketSignalType.LIKE,
      MarketSignalType.COMMENT,
      MarketSignalType.THREAD,
      MarketSignalType.SUGGESTION_ITEM_CART_ADD,
      MarketSignalType.SUGGESTION_ITEM_WISHLIST,
    ];
    expect(
      decideMarketSignalContributions(
        hard.map((type) => ev(type)),
        user,
        EMPTY_MARKET_SIGNAL_CONTRIBUTION_CONTEXT,
      ),
    ).toEqual(hard.map(() => 'hard-claim'));
    expect(
      contributionContextRequired(
        hard.map((type) => ev(type)),
        user,
      ),
    ).toBe(false);
  });

  it('excludes operators without reading history', () => {
    const operator = { ...user, operator: true };
    const events = [ev(MarketSignalType.ITEM_IMPRESSION)];
    expect(contributionContextRequired(events, operator)).toBe(false);
    expect(
      decideMarketSignalContributions(
        events,
        operator,
        EMPTY_MARKET_SIGNAL_CONTRIBUTION_CONTEXT,
      ),
    ).toEqual(['operator']);
  });

  it('excludes owned and staffed targets case-insensitively', () => {
    const context = parseContributionContext([
      {
        recentCount: 0,
        history: [],
        ownedTargets: JSON.stringify([['PRODUCT', PRODUCT]]),
      },
    ]);
    expect(
      decideMarketSignalContributions(
        [
          ev(MarketSignalType.ITEM_IMPRESSION, PRODUCT.toUpperCase()),
          ev(MarketSignalType.ITEM_IMPRESSION, OTHER),
        ],
        user,
        context,
      ),
    ).toEqual(['owner', 'counted']);
  });

  it('gates opens and clicks on a served impression from this batch or the last 30 minutes', () => {
    expect(
      decideMarketSignalContributions(
        [ev(MarketSignalType.OPEN), ev(MarketSignalType.ITEM_CLICK)],
        user,
        EMPTY_MARKET_SIGNAL_CONTRIBUTION_CONTEXT,
      ),
    ).toEqual(['ungated', 'ungated']);
    expect(
      decideMarketSignalContributions(
        [ev(MarketSignalType.OPEN), ev(MarketSignalType.ITEM_IMPRESSION)],
        user,
        EMPTY_MARKET_SIGNAL_CONTRIBUTION_CONTEXT,
      ),
    ).toEqual(['counted', 'counted']);
    const stale = history([
      ['PRODUCT', PRODUCT, MarketSignalType.ITEM_IMPRESSION, 1, 0],
    ]);
    expect(
      decideMarketSignalContributions([ev(MarketSignalType.OPEN)], user, stale),
    ).toEqual(['ungated']);
    const recent = history([
      ['PRODUCT', PRODUCT, MarketSignalType.SUGGESTION_ITEM_VIEW, 1, 1],
    ]);
    expect(
      decideMarketSignalContributions(
        [ev(MarketSignalType.PRODUCT_VIEW)],
        user,
        recent,
      ),
    ).toEqual(['counted']);
    // Section and brand interactions have no item impression to require.
    expect(
      decideMarketSignalContributions(
        [ev(MarketSignalType.CLICK, 'fresh-drops', 'SECTION')],
        user,
        EMPTY_MARKET_SIGNAL_CONTRIBUTION_CONTEXT,
      ),
    ).toEqual(['counted']);
  });

  it('counts one anonymous event per item and class per day', () => {
    expect(
      decideMarketSignalContributions(
        [
          ev(MarketSignalType.ITEM_IMPRESSION),
          ev(MarketSignalType.IMPRESSION),
          ev(MarketSignalType.ITEM_IMPRESSION, OTHER),
        ],
        guest,
        EMPTY_MARKET_SIGNAL_CONTRIBUTION_CONTEXT,
      ),
    ).toEqual(['counted', 'capped', 'counted']);
    const seen = history([
      ['PRODUCT', PRODUCT, MarketSignalType.IMPRESSION, 1, 1],
    ]);
    expect(
      decideMarketSignalContributions(
        [ev(MarketSignalType.ITEM_IMPRESSION), ev(MarketSignalType.OPEN)],
        guest,
        seen,
      ),
    ).toEqual(['capped', 'counted']);
  });

  it('applies the approved per-account caps of 50 impressions and 10 opens', () => {
    const impressions = history([
      ['PRODUCT', PRODUCT, MarketSignalType.ITEM_IMPRESSION, 49, 1],
    ]);
    expect(
      decideMarketSignalContributions(
        [
          ev(MarketSignalType.ITEM_IMPRESSION),
          ev(MarketSignalType.ITEM_IMPRESSION),
        ],
        user,
        impressions,
      ),
    ).toEqual(['counted', 'capped']);
    const opens = history([
      ['PRODUCT', PRODUCT, MarketSignalType.ITEM_IMPRESSION, 1, 1],
      ['PRODUCT', PRODUCT, MarketSignalType.OPEN, 6, 6],
      ['PRODUCT', PRODUCT, MarketSignalType.PRODUCT_VIEW, 4, 4],
    ]);
    expect(
      decideMarketSignalContributions(
        [ev(MarketSignalType.ITEM_VIEW)],
        user,
        opens,
      ),
    ).toEqual(['capped']);
  });

  it('stops counting once the rolling identity budget is spent', () => {
    const budget = MARKET_SIGNAL_CONTRIBUTION_BUDGET.ANONYMOUS;
    const context = history([], { recentCount: budget - 1 });
    expect(
      decideMarketSignalContributions(
        [
          ev(MarketSignalType.ITEM_IMPRESSION),
          ev(MarketSignalType.ITEM_IMPRESSION, OTHER),
        ],
        guest,
        context,
      ),
    ).toEqual(['counted', 'capped']);
  });

  it('reports the budget crossing exactly once, including a batch that lands on the boundary', () => {
    const budget = MARKET_SIGNAL_CONTRIBUTION_BUDGET.USER;
    const at = (recentCount: number) => history([], { recentCount });
    expect(contributionBudgetCrossed(user, at(budget - 50), 50)).toBe(false);
    expect(contributionBudgetCrossed(user, at(budget), 1)).toBe(true);
    expect(contributionBudgetCrossed(user, at(budget - 1), 2)).toBe(true);
    expect(contributionBudgetCrossed(user, at(budget + 1), 50)).toBe(false);
  });

  it('reports concentrated velocity only on the transition into the anomaly', () => {
    const items = (count: number) =>
      Array.from({ length: count }, (_, index) => ['PRODUCT', `item-${index}`]);
    const context = (previous: [number, number], current: [number, number]) =>
      history([], {
        previousEvents: previous[0],
        previousTargets: items(previous[1]),
        currentEvents: current[0],
        currentTargets: items(current[1]),
      });
    const batch = Array.from({ length: 10 }, () =>
      ev(MarketSignalType.ITEM_IMPRESSION, 'item-0'),
    );
    expect(
      contributionVelocityCrossed(
        context(
          [MARKET_SIGNAL_VELOCITY_EVENTS - 5, 3],
          [MARKET_SIGNAL_VELOCITY_EVENTS - 5, 3],
        ),
        batch,
      ),
    ).toEqual({ events: MARKET_SIGNAL_VELOCITY_EVENTS + 5, targets: 3 });
    expect(
      contributionVelocityCrossed(
        context(
          [MARKET_SIGNAL_VELOCITY_EVENTS + 1, 3],
          [MARKET_SIGNAL_VELOCITY_EVENTS + 1, 3],
        ),
        batch,
      ),
    ).toBeNull();
    // Targets ageing out between batches still produce one transition.
    expect(
      contributionVelocityCrossed(
        context(
          [MARKET_SIGNAL_VELOCITY_EVENTS + 40, 6],
          [MARKET_SIGNAL_VELOCITY_EVENTS + 20, 2],
        ),
        batch,
      ),
    ).toEqual({ events: MARKET_SIGNAL_VELOCITY_EVENTS + 30, targets: 2 });
    expect(
      contributionVelocityCrossed(
        context(
          [MARKET_SIGNAL_VELOCITY_EVENTS, 6],
          [MARKET_SIGNAL_VELOCITY_EVENTS, 6],
        ),
        batch,
      ),
    ).toBeNull();
  });

  it('reads history in one bounded statement and never casts non-UUID ids', () => {
    const sql = buildContributionContextQuery({
      actor: user,
      events: [
        ev(MarketSignalType.ITEM_IMPRESSION),
        ev(MarketSignalType.ITEM_IMPRESSION, 'not-a-uuid'),
        ev(MarketSignalType.SECTION_VIEW, 'fresh-drops', 'SECTION'),
      ],
      readAt: new Date('2026-11-25T12:00:00.000Z'),
    });
    expect(sql.text).toContain('LIMIT');
    expect(sql.values).toContain(MARKET_SIGNAL_CONTRIBUTION_BUDGET.USER + 1);
    expect(sql.values).toContainEqual([PRODUCT]);
    // Only the history target list carries it; the ownership list is UUID-only.
    expect(
      sql.values.filter(
        (value) => Array.isArray(value) && value.includes('not-a-uuid'),
      ),
    ).toHaveLength(1);
    const anonymous = buildContributionContextQuery({
      actor: guest,
      events: [ev(MarketSignalType.ITEM_IMPRESSION)],
      readAt: new Date('2026-11-25T12:00:00.000Z'),
    });
    expect(anonymous.text).not.toContain('"BrandMember"');
    expect(anonymous.values).toContain('device-1');
  });

  it('parses driver rows defensively', () => {
    expect(parseContributionContext([])).toBe(
      EMPTY_MARKET_SIGNAL_CONTRIBUTION_CONTEXT,
    );
    const parsed = parseContributionContext([
      {
        recentCount: BigInt(7),
        history: [['PRODUCT', PRODUCT], 'junk', [1, 2, 3, 4, 5]],
        ownedTargets: '{"not":"an array"}',
        currentEvents: -4,
      },
    ]);
    expect(parsed.recentCount).toBe(7);
    expect(parsed.history.size).toBe(0);
    expect(parsed.ownedTargets.size).toBe(0);
    expect(parsed.velocity.current.events).toBe(0);
    // Corrupt history fails the batch instead of silently counting everything.
    expect(() =>
      parseContributionContext([{ recentCount: 0, history: 'not json' }]),
    ).toThrow(SyntaxError);
  });
});
