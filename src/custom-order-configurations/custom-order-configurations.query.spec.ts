import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QueryVisibleCustomOrderConfigurationsDto } from './dto/custom-order-configurations.dto';

describe('Custom configuration active-filter request validation', () => {
  it.each([
    ['false', false], ['true', true], [false, false], [true, true],
  ])('accepts %p without truthy coercion', async (input, expected) => {
    const dto = plainToInstance(QueryVisibleCustomOrderConfigurationsDto, { isActive: input }, {
      enableImplicitConversion: true,
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto.isActive).toBe(expected);
  });

  it.each(['', 'unknown', '0', '1', 0, 1, null, [], ['false']])(
    'rejects invalid boolean filter %p instead of silently treating it as active', async (isActive) => {
      const dto = plainToInstance(QueryVisibleCustomOrderConfigurationsDto, { isActive }, {
        enableImplicitConversion: true,
      });
      const errors = await validate(dto);
      expect(errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ property: 'isActive', constraints: { isBoolean: expect.any(String) } }),
      ]));
    },
  );

  it('leaves the omitted filter unset so owner listings include both states', async () => {
    const dto = plainToInstance(QueryVisibleCustomOrderConfigurationsDto, {}, { enableImplicitConversion: true });
    expect(await validate(dto)).toEqual([]);
    expect(dto.isActive).toBeUndefined();
  });
});
