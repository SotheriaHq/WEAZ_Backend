import {
  DEFAULT_COLLECTION_CATEGORIES,
  DEFAULT_FILTER_DIMENSIONS,
  DEFAULT_SUB_CATEGORIES,
  LEGACY_CATEGORY_SLUGS,
  LEGACY_FILTER_DIMENSION_SLUGS,
} from './default-taxonomy';
import {
  LEGACY_DISCOVERY_DIMENSION_SLUGS,
  REQUIRED_DISCOVERY_APPLIES_TO,
  REQUIRED_DISCOVERY_DIMENSION_SLUGS,
} from './taxonomy-governance';

describe('default taxonomy contract', () => {
  it('does not seed audience, service, or future non-garment concepts as top-level garment categories', () => {
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
      'accessories',
      'footwear',
      'bags',
      'jewelry',
      'shoes',
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
        'accessories',
        'footwear',
        'bags',
        'jewelry',
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

  it('keeps the active discovery metadata contract verifyable from seed data', () => {
    const dimensionsBySlug = new Map(
      DEFAULT_FILTER_DIMENSIONS.map((dimension) => [dimension.slug, dimension]),
    );

    for (const slug of REQUIRED_DISCOVERY_DIMENSION_SLUGS) {
      const dimension = dimensionsBySlug.get(slug);
      expect(dimension).toBeDefined();
      expect(dimension?.appliesTo).toEqual(
        expect.arrayContaining([...REQUIRED_DISCOVERY_APPLIES_TO]),
      );
    }

    for (const legacySlug of LEGACY_DISCOVERY_DIMENSION_SLUGS) {
      expect(dimensionsBySlug.has(legacySlug)).toBe(false);
      expect(LEGACY_FILTER_DIMENSION_SLUGS).toContain(legacySlug);
    }
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
