import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  BRAND_PROFILE_TAG_LIMIT,
  UpdateBrandProfileDto,
} from './update-brand-profile.dto';

describe('UpdateBrandProfileDto', () => {
  const makeTags = (count: number) =>
    Array.from({ length: count }, (_, index) => `tag-${index + 1}`);

  it('allows the current brand setup tag limit', async () => {
    const dto = plainToInstance(UpdateBrandProfileDto, {
      brandTags: makeTags(BRAND_PROFILE_TAG_LIMIT),
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects more than the current brand setup tag limit', async () => {
    const dto = plainToInstance(UpdateBrandProfileDto, {
      brandTags: makeTags(BRAND_PROFILE_TAG_LIMIT + 1),
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('arrayMaxSize');
  });
});
