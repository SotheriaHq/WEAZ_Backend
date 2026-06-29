import { BadRequestException } from '@nestjs/common';
import { CollectionsService } from './collections.service';

/**
 * Phase 2B focused contract test for the minPrice <= maxPrice guard.
 * assertValidPriceRange is pure, so we call it off the prototype.
 */
describe('CollectionsService.assertValidPriceRange (Phase 2B)', () => {
  const svc = Object.create(
    CollectionsService.prototype,
  ) as CollectionsService;
  const assert = (min: any, max: any) =>
    (svc as any).assertValidPriceRange(min, max);

  it('allows min < max', () => {
    expect(() => assert(10, 20)).not.toThrow();
  });

  it('allows min == max', () => {
    expect(() => assert(15, 15)).not.toThrow();
  });

  it('skips validation when either bound is missing', () => {
    expect(() => assert(undefined, 20)).not.toThrow();
    expect(() => assert(10, null)).not.toThrow();
    expect(() => assert(null, null)).not.toThrow();
  });

  it('rejects min > max with a field-mapped error', () => {
    expect.assertions(2);
    try {
      assert(50, 20);
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        field: 'maxPrice',
        code: 'PRICE_RANGE_INVALID',
      });
    }
  });
});
