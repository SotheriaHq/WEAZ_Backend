import {
  DEFAULT_COLLECTION_CATEGORIES,
  DEFAULT_FILTER_DIMENSIONS,
  DEFAULT_SUB_CATEGORIES,
  LEGACY_CATEGORY_SLUGS,
} from './default-taxonomy';

describe('default taxonomy contract', () => {
  it('does not seed audience or service concepts as top-level garment categories', () => {
    const forbiddenCategorySlugs = new Set([
      'womens-wear',
      'mens-wear',
      'unisex-accessories',
      'custom-bespoke',
      'women',
      'men',
      'unisex',
      'african',
      'cultural',
      'wedding',
      'corporate',
      'casual',
      'luxury',
      'bespoke',
      'custom',
      'ready-to-wear',
    ]);

    const categorySlugs = DEFAULT_COLLECTION_CATEGORIES.map(
      (category) => category.slug,
    );
    expect(categorySlugs).toEqual(
      expect.arrayContaining([
        'dresses-gowns',
        'tops-shirts',
        'trousers-shorts',
        'skirts',
        'agbada',
        'bridal-wear',
        'accessories',
      ]),
    );
    expect(categorySlugs.some((slug) => forbiddenCategorySlugs.has(slug))).toBe(
      false,
    );
  });

  it('keeps legacy audience/use-case category slugs marked for deactivation', () => {
    expect(LEGACY_CATEGORY_SLUGS).toEqual(
      expect.arrayContaining([
        'womens-wear',
        'mens-wear',
        'unisex-accessories',
        'custom-bespoke',
        'african-fashion',
        'western-fashion',
        'indian-fashion',
      ]),
    );
  });

  it('seeds required discovery dimensions including heritage', () => {
    const dimensionSlugs = DEFAULT_FILTER_DIMENSIONS.map((dim) => dim.slug);
    expect(dimensionSlugs).toEqual(
      expect.arrayContaining([
        'style',
        'heritage',
        'occasion',
        'fabric',
        'color-family',
        'fit',
      ]),
    );

    const heritage = DEFAULT_FILTER_DIMENSIONS.find(
      (dim) => dim.slug === 'heritage',
    );
    expect(heritage?.values.map((value) => value.slug)).toEqual(
      expect.arrayContaining([
        'african-cultural',
        'ankara',
        'aso-ebi',
        'aso-oke',
        'yoruba-traditional',
        'igbo-traditional',
        'hausa-arewa-traditional',
      ]),
    );
  });

  it('does not seed known audience, occasion, price, or service concepts as subcategories', () => {
    const forbiddenSubCategorySlugs = new Set([
      'plus-size-curvy',
      'wedding-events',
      'casual-wear',
      'formal-wear',
      'custom',
      'bespoke',
      'luxury',
    ]);

    const subCategorySlugs = Object.values(DEFAULT_SUB_CATEGORIES).flatMap(
      (values) => values.map((value) => value.slug),
    );

    expect(
      subCategorySlugs.some((slug) => forbiddenSubCategorySlugs.has(slug)),
    ).toBe(false);
  });
});
