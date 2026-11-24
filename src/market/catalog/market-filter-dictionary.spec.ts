import { BadRequestException } from '@nestjs/common';
import {
  validateMarketDimensions,
  validateMarketDimensionLayers,
} from './market-filter-dictionary';

describe('active product filter dictionary', () => {
  const findMany = jest.fn();
  const tx = { filterDimension: { findMany } } as unknown as Parameters<
    typeof validateMarketDimensions
  >[0];
  beforeEach(() => findMany.mockReset());

  it('does not load a dictionary for a request with no dimensions', async () => {
    await validateMarketDimensions(tx, {});
    expect(findMany).not.toHaveBeenCalled();
  });

  it('validates fixed and shopper dimensions in one query without merging non-multi selections', async () => {
    findMany.mockResolvedValue([
      {
        slug: 'style',
        isMulti: false,
        values: [{ slug: 'minimal' }, { slug: 'casual' }],
      },
    ]);
    await validateMarketDimensionLayers(tx, [
      { dimensions: { style: ['minimal'] } },
      { dimensions: { style: ['casual'] } },
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.slug.in).toEqual(['style']);
    expect(findMany.mock.calls[0][0].select.values.where.slug.in).toEqual([
      'minimal',
      'casual',
    ]);
  });

  it('validates all selected dimensions with one bounded relation query', async () => {
    findMany.mockResolvedValue([
      {
        slug: 'style',
        isMulti: true,
        values: [{ slug: 'minimal' }, { slug: 'casual' }],
      },
      { slug: 'fabric', isMulti: false, values: [{ slug: 'cotton' }] },
    ]);
    await validateMarketDimensions(tx, {
      dimensions: { style: ['minimal', 'casual'], fabric: ['cotton'] },
    });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        slug: { in: ['style', 'fabric'] },
        isActive: true,
        appliesTo: { has: 'PRODUCT' },
      },
      select: {
        slug: true,
        isMulti: true,
        values: {
          where: {
            isActive: true,
            slug: { in: ['minimal', 'casual', 'cotton'] },
          },
          select: { slug: true },
        },
      },
    });
  });

  it.each([
    { rows: [] },
    {
      rows: [
        {
          slug: 'style',
          isMulti: false,
          values: [{ slug: 'minimal' }, { slug: 'casual' }],
        },
      ],
    },
    { rows: [{ slug: 'style', isMulti: true, values: [{ slug: 'minimal' }] }] },
  ])(
    'rejects unknown, inactive, wrong-entity or disallowed values: %j',
    async ({ rows }) => {
      findMany.mockResolvedValue(rows);
      await expect(
        validateMarketDimensions(tx, {
          dimensions: { style: ['minimal', 'casual'] },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('propagates database failure instead of fabricating an invalid-filter response', async () => {
    const error = new Error('Database unavailable');
    findMany.mockRejectedValue(error);
    await expect(
      validateMarketDimensions(tx, { dimensions: { style: ['minimal'] } }),
    ).rejects.toBe(error);
  });
});
