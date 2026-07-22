import {
  adminAttentionActiveWhere,
  clearAdminAttention,
  clearAdminAttentionMany,
  markAdminAttention,
  resolveAttentionCooldownHours,
  TERMINAL_CUSTOM_ORDER_STATUSES,
} from './custom-order-admin-attention';
import { CustomOrderStatus } from '@prisma/client';

describe('custom-order-admin-attention', () => {
  const updateMany = jest.fn();
  const prisma = { customOrder: { updateMany } };

  beforeEach(() => {
    updateMany.mockReset();
    updateMany.mockResolvedValue({ count: 1 });
  });

  describe('resolveAttentionCooldownHours', () => {
    it('defaults to 6 hours for missing/invalid env', () => {
      expect(resolveAttentionCooldownHours(undefined)).toBe(6);
      expect(resolveAttentionCooldownHours('nope')).toBe(6);
      expect(resolveAttentionCooldownHours('-1')).toBe(6);
    });

    it('accepts finite non-negative values and caps at 168h', () => {
      expect(resolveAttentionCooldownHours('0')).toBe(0);
      expect(resolveAttentionCooldownHours('12')).toBe(12);
      expect(resolveAttentionCooldownHours('999')).toBe(168);
    });
  });

  describe('adminAttentionActiveWhere', () => {
    it('requires a set flag, non-anonymized, non-terminal status', () => {
      expect(adminAttentionActiveWhere({ brandId: 'b1' })).toEqual({
        brandId: 'b1',
        adminAttentionRequiredAt: { not: null },
        anonymizedAt: null,
        status: { notIn: TERMINAL_CUSTOM_ORDER_STATUSES },
      });
      expect(TERMINAL_CUSTOM_ORDER_STATUSES).toEqual(
        expect.arrayContaining([
          CustomOrderStatus.COMPLETED,
          CustomOrderStatus.CLOSED,
          CustomOrderStatus.REFUND_IN_PROGRESS,
          CustomOrderStatus.CANCELLED_BY_BUYER_PRE_ACCEPTANCE,
          CustomOrderStatus.REJECTED_BY_BRAND,
        ]),
      );
    });
  });

  describe('markAdminAttention', () => {
    it('sets the flag only when currently unset, non-terminal, past cooldown', async () => {
      const didSet = await markAdminAttention(prisma, 'co_1', 'DISPUTE_OPENED', {
        cooldownHours: 6,
      });

      expect(didSet).toBe(true);
      expect(updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: 'co_1',
          adminAttentionRequiredAt: null,
          anonymizedAt: null,
          status: { notIn: TERMINAL_CUSTOM_ORDER_STATUSES },
          OR: [
            { adminAttentionClearedAt: null },
            { adminAttentionClearedAt: { lt: expect.any(Date) } },
          ],
        }),
        data: expect.objectContaining({
          adminAttentionReason: 'DISPUTE_OPENED',
          adminAttentionClearedAt: null,
          adminAttentionClearedById: null,
        }),
      });
    });

    it('returns false when updateMany matches zero rows', async () => {
      updateMany.mockResolvedValue({ count: 0 });
      await expect(
        markAdminAttention(prisma, 'co_1', 'ISSUE_REPORTED'),
      ).resolves.toBe(false);
    });

    it('swallows errors and reports via onError', async () => {
      const onError = jest.fn();
      updateMany.mockRejectedValue(new Error('db down'));
      await expect(
        markAdminAttention(prisma, 'co_1', 'STALE_STAGE', { onError }),
      ).resolves.toBe(false);
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('co_1'),
      );
    });
  });

  describe('clearAdminAttention', () => {
    it('clears only flagged rows and records the actor', async () => {
      await clearAdminAttention(prisma, 'co_1', 'admin_1');
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: 'co_1',
          adminAttentionRequiredAt: { not: null },
        },
        data: expect.objectContaining({
          adminAttentionRequiredAt: null,
          adminAttentionClearedById: 'admin_1',
          adminAttentionClearedAt: expect.any(Date),
        }),
      });
    });

    it('bulk-clears a unique set of ids', async () => {
      updateMany.mockResolvedValue({ count: 2 });
      const count = await clearAdminAttentionMany(
        prisma,
        ['co_1', 'co_1', 'co_2'],
        'admin_1',
      );
      expect(count).toBe(2);
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['co_1', 'co_2'] },
          adminAttentionRequiredAt: { not: null },
        },
        data: expect.objectContaining({
          adminAttentionRequiredAt: null,
          adminAttentionClearedById: 'admin_1',
        }),
      });
    });

    it('no-ops on empty bulk input', async () => {
      await expect(clearAdminAttentionMany(prisma, [])).resolves.toBe(0);
      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  describe('markAdminAttentionMany / mapPool / admin cache', () => {
    const {
      markAdminAttentionMany,
      mapPool,
      getCachedActiveAdminIds,
      clearActiveAdminIdsCache,
    } = require('./custom-order-admin-attention') as typeof import('./custom-order-admin-attention');

    it('batch-marks unique ids with the same guards as single mark', async () => {
      updateMany.mockResolvedValue({ count: 2 });
      const count = await markAdminAttentionMany(
        prisma,
        ['co_1', 'co_1', 'co_2'],
        'STALE_STAGE',
        { cooldownHours: 6 },
      );
      expect(count).toBe(2);
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { in: ['co_1', 'co_2'] },
            adminAttentionRequiredAt: null,
          }),
          data: expect.objectContaining({
            adminAttentionReason: 'STALE_STAGE',
          }),
        }),
      );
    });

    it('mapPool runs with bounded concurrency', async () => {
      const seen: number[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        seen.push(n);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
      });
      expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
      expect(maxInFlight).toBeLessThanOrEqual(2);
    });

    it('caches active admin ids across calls', async () => {
      clearActiveAdminIdsCache();
      const findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
      const userPrisma = { user: { findMany } };
      const first = await getCachedActiveAdminIds(userPrisma);
      const second = await getCachedActiveAdminIds(userPrisma);
      expect(first).toEqual(['a1', 'a2']);
      expect(second).toEqual(['a1', 'a2']);
      expect(findMany).toHaveBeenCalledTimes(1);
    });
  });
});
