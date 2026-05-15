/**
 * Default Category Taxonomy — Expanded for African Fashion Commerce
 *
 * Structure:
 *  MainCategory  → 4 gender/use-case categories
 *  SubCategory   → 22 garment types, scoped per main category
 *  FilterDimension → 7 orthogonal filter dimensions with 52 values
 */

// =====================
// Helpers
// =====================

export function toSeedSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// =====================
// Types
// =====================

export interface CategorySeed {
  slug: string;
  name: string;
  description: string;
  order: number;
}

export interface SubCategorySeed {
  slug: string;
  name: string;
  description: string;
  order: number;
}

export interface FilterValueSeed {
  slug: string;
  name: string;
  order: number;
}

export interface FilterDimensionSeed {
  slug: string;
  name: string;
  description: string;
  order: number;
  isMulti: boolean;
  appliesTo: string[];
  values: FilterValueSeed[];
}

const CATALOG_FILTER_APPLIES_TO = ['COLLECTION', 'STORE_COLLECTION', 'DESIGN', 'PRODUCT'];

// =====================
// Main Categories (4)
// =====================

export const DEFAULT_COLLECTION_CATEGORIES: CategorySeed[] = [
  {
    slug: 'womens-wear',
    name: "Women's Wear",
    description:
      'Dresses, tops, skirts, pants, outerwear, and plus-size fashion for women',
    order: 1,
  },
  {
    slug: 'mens-wear',
    name: "Men's Wear",
    description:
      'Shirts, trousers, agbada, kaftans, suits, and streetwear for men',
    order: 2,
  },
  {
    slug: 'unisex-accessories',
    name: 'Unisex / Accessories',
    description:
      'Bags, shoes, jewelry, headwear, scarves, belts, and ties for everyone',
    order: 3,
  },
  {
    slug: 'custom-bespoke',
    name: 'Custom / Bespoke',
    description:
      'Traditional outfits, fusion styles, wedding/event wear, and children\'s wear — made to your specifications',
    order: 4,
  },
];

// =====================
// Sub-Categories (22, scoped per main)
// =====================

export const DEFAULT_SUB_CATEGORIES: Record<string, SubCategorySeed[]> = {
  'womens-wear': [
    { slug: 'dresses-gowns', name: 'Dresses & Gowns', order: 1, description: 'Ankara, lace, chiffon, bodycon dresses and gowns' },
    { slug: 'tops-blouses', name: 'Tops & Blouses', order: 2, description: 'Buba, off-shoulder, crop, peplum tops' },
    { slug: 'skirts-wraps', name: 'Skirts & Wraps', order: 3, description: 'Wrapper, pencil, maxi, A-line skirts' },
    { slug: 'pants-trousers-w', name: 'Pants & Trousers', order: 4, description: 'High-waist, palazzo, culottes, wide-leg' },
    { slug: 'outerwear-w', name: 'Outerwear', order: 5, description: 'Dashiki jackets, kimono, shawls, capes' },
    { slug: 'plus-size-curvy', name: 'Plus Size / Curvy', order: 6, description: 'Fashion designed for plus-size and curvy women' },
    { slug: 'jumpsuits-rompers', name: 'Jumpsuits & Rompers', order: 7, description: 'Full-length jumpsuits, playsuits, coveralls' },
  ],
  'mens-wear': [
    { slug: 'shirts-tops-m', name: 'Shirts & Tops', order: 1, description: 'Dashiki, kaftan top, polo, henley shirts' },
    { slug: 'trousers-chinos', name: 'Trousers & Chinos', order: 2, description: 'Slim-fit, wide-leg, senator trousers' },
    { slug: 'agbada-kaftans', name: 'Agbada & Kaftans', order: 3, description: 'Traditional agbada, modern kaftan, senator wear' },
    { slug: 'suits-blazers', name: 'Suits & Blazers', order: 4, description: 'Tailored suits, aso-ebi blazers, tuxedos' },
    { slug: 'streetwear-m', name: 'Streetwear', order: 5, description: 'Hoodies, joggers, graphic tees, sneaker sets' },
    { slug: 'shorts-casual-m', name: 'Shorts & Casual', order: 6, description: 'Bermuda, cargo, linen shorts and casual wear' },
  ],
  'unisex-accessories': [
    { slug: 'bags-purses', name: 'Bags & Purses', order: 1, description: 'Beaded bags, leather clutch, tote, backpack' },
    { slug: 'shoes-sandals', name: 'Shoes & Sandals', order: 2, description: 'Krobo bead sandals, sneakers, slippers, loafers' },
    { slug: 'jewelry', name: 'Jewelry', order: 3, description: 'Coral beads, gold jewelry, waist beads, cufflinks' },
    { slug: 'headwear-scarves', name: 'Headwear & Scarves', order: 4, description: 'Gele, turban, hijab, aso-oke cap, fila' },
    { slug: 'belts-ties', name: 'Belts & Ties', order: 5, description: 'Traditional weave belts, leather belts, bow ties' },
  ],
  'custom-bespoke': [
    { slug: 'traditional-outfits', name: 'Traditional Outfits', order: 1, description: 'Agbada set, buba & iro, aso-ebi, adire set' },
    { slug: 'fusion-styles', name: 'Fusion Styles', order: 2, description: 'African-Western mix, Afro-Indian, modern traditional' },
    { slug: 'wedding-events', name: 'Wedding & Events', order: 3, description: 'Aso-ebi sets, bridesmaid, groomsmen, bridal' },
    { slug: 'childrens-wear', name: "Children's Wear", order: 4, description: 'Mini dashiki, kids kaftan, school uniforms' },
  ],
};

// =====================
// Filter Dimensions (7) with Values (52)
// =====================

export const DEFAULT_FILTER_DIMENSIONS: FilterDimensionSeed[] = [
  {
    slug: 'fabric-type',
    name: 'Fabric Type',
    description: 'Material/textile used in the garment',
    order: 1,
    isMulti: true,
    appliesTo: CATALOG_FILTER_APPLIES_TO,
    values: [
      { slug: 'ankara', name: 'Ankara', order: 1 },
      { slug: 'aso-oke', name: 'Aso-Oke', order: 2 },
      { slug: 'lace', name: 'Lace', order: 3 },
      { slug: 'adire', name: 'Adire', order: 4 },
      { slug: 'cotton', name: 'Cotton', order: 5 },
      { slug: 'silk', name: 'Silk', order: 6 },
      { slug: 'velvet', name: 'Velvet', order: 7 },
      { slug: 'chiffon', name: 'Chiffon', order: 8 },
      { slug: 'denim', name: 'Denim', order: 9 },
      { slug: 'kente', name: 'Kente', order: 10 },
      { slug: 'mud-cloth', name: 'Mud Cloth', order: 11 },
      { slug: 'batik', name: 'Batik', order: 12 },
      { slug: 'organza', name: 'Organza', order: 13 },
      { slug: 'satin', name: 'Satin', order: 14 },
    ],
  },
  {
    slug: 'style',
    name: 'Style',
    description: 'Design aesthetic / fashion style',
    order: 2,
    isMulti: true,
    appliesTo: CATALOG_FILTER_APPLIES_TO,
    values: [
      { slug: 'traditional-nigerian', name: 'Traditional Nigerian', order: 1 },
      { slug: 'afro-modern', name: 'Afro-Modern', order: 2 },
      { slug: 'streetwear-style', name: 'Streetwear', order: 3 },
      { slug: 'formal', name: 'Formal', order: 4 },
      { slug: 'wedding-style', name: 'Wedding', order: 5 },
      { slug: 'festival', name: 'Festival', order: 6 },
      { slug: 'minimalist', name: 'Minimalist', order: 7 },
      { slug: 'bold-prints', name: 'Bold Prints', order: 8 },
      { slug: 'western-casual', name: 'Western Casual', order: 9 },
      { slug: 'indian-fusion', name: 'Indian Fusion', order: 10 },
    ],
  },
  {
    slug: 'occasion',
    name: 'Occasion',
    description: 'When/where to wear it',
    order: 3,
    isMulti: true,
    appliesTo: CATALOG_FILTER_APPLIES_TO,
    values: [
      { slug: 'everyday', name: 'Everyday', order: 1 },
      { slug: 'work-office', name: 'Work / Office', order: 2 },
      { slug: 'party-night-out', name: 'Party / Night Out', order: 3 },
      { slug: 'wedding-occasion', name: 'Wedding', order: 4 },
      { slug: 'festival-eid-sallah-owambe', name: 'Festival (Eid, Sallah, Owambe)', order: 5 },
      { slug: 'church', name: 'Church', order: 6 },
      { slug: 'graduation', name: 'Graduation', order: 7 },
      { slug: 'date-night', name: 'Date Night', order: 8 },
    ],
  },
  {
    slug: 'color-family',
    name: 'Color Family',
    description: 'Dominant color palette',
    order: 4,
    isMulti: true,
    appliesTo: CATALOG_FILTER_APPLIES_TO,
    values: [
      { slug: 'bold-print-colors', name: 'Bold Prints', order: 1 },
      { slug: 'earth-tones', name: 'Earth Tones', order: 2 },
      { slug: 'pastels', name: 'Pastels', order: 3 },
      { slug: 'monochrome', name: 'Monochrome', order: 4 },
      { slug: 'metallic-gold-silver', name: 'Metallic (Gold/Silver)', order: 5 },
      { slug: 'neutrals', name: 'Neutrals', order: 6 },
    ],
  },
  {
    slug: 'fit-shape',
    name: 'Fit / Shape',
    description: 'Garment silhouette and fit',
    order: 5,
    isMulti: true,
    appliesTo: CATALOG_FILTER_APPLIES_TO,
    values: [
      { slug: 'loose-flowy', name: 'Loose / Flowy', order: 1 },
      { slug: 'fitted', name: 'Fitted', order: 2 },
      { slug: 'oversized', name: 'Oversized', order: 3 },
      { slug: 'curvy-plus', name: 'Curvy / Plus', order: 4 },
      { slug: 'petite', name: 'Petite', order: 5 },
    ],
  },
  {
    slug: 'designer-location',
    name: 'Designer Location',
    description: 'Where the designer/brand is based',
    order: 6,
    isMulti: false,
    appliesTo: CATALOG_FILTER_APPLIES_TO,
    values: [
      { slug: 'lagos', name: 'Lagos', order: 1 },
      { slug: 'abuja', name: 'Abuja', order: 2 },
      { slug: 'accra', name: 'Accra', order: 3 },
      { slug: 'port-harcourt', name: 'Port Harcourt', order: 4 },
      { slug: 'london', name: 'London', order: 5 },
      { slug: 'online-only', name: 'Online Only', order: 6 },
    ],
  },
  {
    slug: 'price-range',
    name: 'Price Range',
    description: 'Approximate price bracket (NGN)',
    order: 7,
    isMulti: false,
    appliesTo: CATALOG_FILTER_APPLIES_TO,
    values: [
      { slug: 'budget-5k-20k', name: '₦5k – ₦20k', order: 1 },
      { slug: 'mid-range-20k-50k', name: '₦20k – ₦50k', order: 2 },
      { slug: 'premium-50k-plus', name: '₦50k+', order: 3 },
    ],
  },
];

// =====================
// Filter → Tag Auto-Suggestion Map
// =====================

export const FILTER_TAG_SUGGESTIONS: Record<string, string[]> = {
  // Fabric
  'ankara': ['ankara-fashion', 'african-prints', 'bold-prints'],
  'aso-oke': ['aso-oke', 'traditional-yoruba', 'owambe'],
  'lace': ['lace-style', 'lacewear', 'elegant'],
  'adire': ['adire', 'tie-dye', 'indigenous-craft'],
  'cotton': ['cotton-wear', 'casual-comfort'],
  'silk': ['silk-luxury', 'premium-fabric'],
  'velvet': ['velvet-glam', 'rich-textures'],
  'kente': ['kente-cloth', 'ghanaian-fashion', 'woven-textiles'],
  'mud-cloth': ['mud-cloth', 'malian-fashion', 'artisan-craft'],
  'batik': ['batik-prints', 'hand-dyed', 'artisan'],
  // Style
  'traditional-nigerian': ['yoruba-fashion', 'igbo-fashion', 'hausa-fashion', 'naija-style'],
  'afro-modern': ['afro-fusion', 'modern-african', 'contemporary'],
  'streetwear-style': ['street-style', 'urban-fashion', 'casual-cool'],
  'formal': ['office-wear', 'professional', 'corporate-style'],
  'wedding-style': ['bridal', 'aso-ebi', 'wedding-fashion'],
  'festival': ['owambe', 'eid-fashion', 'sallah-style', 'party-wear'],
  'minimalist': ['simple-elegance', 'clean-lines', 'understated'],
  'bold-prints': ['print-lover', 'statement-piece', 'vibrant'],
  // Occasion
  'wedding-occasion': ['aso-ebi', 'bridal', 'wedding-guest'],
  'festival-eid-sallah-owambe': ['owambe-fashion', 'eid-outfit', 'sallah-style', 'festive'],
  'party-night-out': ['party-dress', 'night-out', 'glamour'],
  'work-office': ['office-style', 'work-outfit', 'corporate'],
  'everyday': ['daily-wear', 'casual', 'comfortable'],
  'church': ['sunday-best', 'modest-fashion', 'church-outfit'],
  // Color Family
  'earth-tones': ['earthy', 'natural-colors', 'warm-palette'],
  'pastels': ['pastel-colors', 'soft-tones', 'light-hues'],
  'metallic-gold-silver': ['gold-fashion', 'silver-accents', 'metallic-glam'],
};

// =====================
// Legacy slugs (for migration — these will be deactivated)
// =====================

export const LEGACY_CATEGORY_SLUGS = [
  'african-fashion',
  'western-fashion',
  'indian-fashion',
];

export const LEGACY_CATEGORY_TYPE_SLUGS = [
  'top', 'trouser', 'gown', 'skirt', 'jacket', 'jumpsuit', 'shorts',
  'dress', 'shirt', 'blouse', 'kaftan', 'agbada', 'aso-oke-wear',
  'adire-wear', 'native-wear', 'casual-wear', 'formal-wear',
  'accessories', 'footwear',
];
