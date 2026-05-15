import { BadRequestException } from '@nestjs/common';

export const REQUIRED_DISCOVERY_DIMENSION_SLUGS = [
  'style',
  'heritage',
  'occasion',
  'fabric',
  'color-family',
  'fit',
] as const;

export const LEGACY_DISCOVERY_DIMENSION_SLUGS = [
  'fabric-type',
  'fit-shape',
  'designer-location',
  'price-range',
] as const;

export const REQUIRED_DISCOVERY_APPLIES_TO = [
  'COLLECTION',
  'STORE_COLLECTION',
  'DESIGN',
  'PRODUCT',
] as const;

export const BLOCKED_GARMENT_TAXONOMY_SLUGS = new Set([
  'women',
  'woman',
  'womens',
  'womens-wear',
  'female',
  'females',
  'men',
  'man',
  'mens',
  'mens-wear',
  'male',
  'males',
  'unisex',
  'everyone',
  'everybody',
  'unisex-accessories',
  'african',
  'african-fashion',
  'cultural',
  'western-fashion',
  'indian-fashion',
  'wedding',
  'corporate',
  'casual',
  'luxury',
  'owambe',
  'custom',
  'bespoke',
  'custom-bespoke',
  'ready-to-wear',
  'ready-to-wear-fashion',
  'ready-to-wear-clothing',
  'rtw',
  'price-range',
  'designer-location',
]);

export function normalizeTaxonomySlug(input: string): string {
  return (
    String(input ?? '')
      .toLowerCase()
      .trim()
      .replace(/&/g, ' and ')
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'taxonomy-item'
  );
}

export function getBlockedTaxonomyGuidance(
  input: string,
  level: 'category' | 'subcategory' = 'category',
): string | null {
  const slug = normalizeTaxonomySlug(input);
  if (!BLOCKED_GARMENT_TAXONOMY_SLUGS.has(slug)) {
    return null;
  }

  const target = level === 'category' ? 'garment category' : 'garment type';
  return `This belongs under audience, style, heritage, occasion, availability, price, or location metadata, not ${target}. Use item-based terms like Dresses & Gowns, Agbada, Tops & Shirts, Maxi dress, Headwrap, or Handbag.`;
}

export function assertGarmentCategoryTermAllowed(input: string): void {
  const guidance = getBlockedTaxonomyGuidance(input, 'category');
  if (guidance) {
    throw new BadRequestException(guidance);
  }
}

export function assertGarmentSubCategoryTermAllowed(input: string): void {
  const guidance = getBlockedTaxonomyGuidance(input, 'subcategory');
  if (guidance) {
    throw new BadRequestException(guidance);
  }
}
