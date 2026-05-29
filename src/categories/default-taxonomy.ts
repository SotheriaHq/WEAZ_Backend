/**
 * Default taxonomy for Threadly catalog metadata.
 *
 * Contract:
 * - Category = garment/item family.
 * - Sub-category = specific garment/item type under that family.
 * - Audience lives in Collection.type / Product.gender, not categories.
 * - Discovery metadata lives in FilterDimension / FilterValue / EntityFilter.
 * - Tags remain hashtags/social search terms, not taxonomy source of truth.
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

const CATALOG_FILTER_APPLIES_TO = [
  'COLLECTION',
  'STORE_COLLECTION',
  'DESIGN',
  'PRODUCT',
];

// =====================
// Garment Categories
// =====================

export const DEFAULT_COLLECTION_CATEGORIES: CategorySeed[] = [
  {
    slug: 'dresses-gowns',
    name: 'Dresses & Gowns',
    description:
      'One-piece dresses and gown silhouettes across short, midi, maxi, fitted, and formal forms.',
    order: 1,
  },
  {
    slug: 'tops-shirts',
    name: 'Tops & Shirts',
    description:
      'Upper-body garments including tees, blouses, shirts, buba tops, crop tops, and peplum tops.',
    order: 2,
  },
  {
    slug: 'trousers-shorts',
    name: 'Trousers & Shorts',
    description:
      'Lower-body garments with divided legs, including trousers, pants, chinos, joggers, culottes, and shorts.',
    order: 3,
  },
  {
    slug: 'skirts',
    name: 'Skirts',
    description:
      'Waist-worn garments with skirt silhouettes including pencil, A-line, maxi, wrap, and pleated styles.',
    order: 4,
  },
  {
    slug: 'suits-blazers',
    name: 'Suits & Blazers',
    description:
      'Tailored jackets, suit sets, tuxedos, waistcoats, and structured formal separates.',
    order: 5,
  },
  {
    slug: 'co-ord-sets',
    name: 'Co-ord Sets',
    description:
      'Matching outfit sets designed as coordinated tops with trousers, skirts, or relaxed separates.',
    order: 6,
  },
  {
    slug: 'outerwear',
    name: 'Outerwear',
    description:
      'Layering garments worn over an outfit, including jackets, kimonos, capes, coats, and shawls.',
    order: 7,
  },
  {
    slug: 'agbada',
    name: 'Agbada',
    description:
      'Flowing robe-based traditional outfits with inner garments and tailored embroidery variations.',
    order: 8,
  },
  {
    slug: 'senator-wear',
    name: 'Senator Wear',
    description:
      'Tailored senator-style tops and trouser sets with short, long-sleeve, and embroidered variations.',
    order: 9,
  },
  {
    slug: 'kaftans',
    name: 'Kaftans',
    description:
      'Loose robe or tunic garments in long, short, embroidered, and everyday kaftan forms.',
    order: 10,
  },
  {
    slug: 'buba-wrapper',
    name: 'Buba & Wrapper',
    description:
      'Traditional buba top and wrapper combinations, including iro and buba sets.',
    order: 11,
  },
  {
    slug: 'native-sets',
    name: 'Native Sets',
    description:
      'Traditional matching outfit sets such as dashiki, aso oke, adire, isi agu, and related native ensembles.',
    order: 12,
  },
  {
    slug: 'bridal-wear',
    name: 'Bridal Wear',
    description:
      'Garments made for bridal parties, including bridal gowns, reception dresses, robes, and groom traditional sets.',
    order: 13,
  },
];

// =====================
// Garment Sub-Categories
// =====================

export const DEFAULT_SUB_CATEGORIES: Record<string, SubCategorySeed[]> = {
  'dresses-gowns': [
    {
      slug: 'mini-dress',
      name: 'Mini dress',
      order: 1,
      description: 'Short dress silhouette that sits above the knee.',
    },
    {
      slug: 'midi-dress',
      name: 'Midi dress',
      order: 2,
      description: 'Mid-length dress silhouette that falls around the calf.',
    },
    {
      slug: 'maxi-dress',
      name: 'Maxi dress',
      order: 3,
      description:
        'Full-length dress silhouette that reaches the ankle or floor.',
    },
    {
      slug: 'bodycon-dress',
      name: 'Bodycon dress',
      order: 4,
      description: 'Close-fitting dress designed to follow the body shape.',
    },
    {
      slug: 'mermaid-gown',
      name: 'Mermaid gown',
      order: 5,
      description: 'Fitted gown that flares around the lower leg.',
    },
    {
      slug: 'ball-gown',
      name: 'Ball gown',
      order: 6,
      description: 'Formal gown with a structured bodice and full skirt.',
    },
    {
      slug: 'shirt-dress',
      name: 'Shirt dress',
      order: 7,
      description:
        'Dress cut with shirt-like collar, placket, or button-down details.',
    },
    {
      slug: 'evening-gown',
      name: 'Evening gown',
      order: 8,
      description: 'Formal full-length gown designed for dressy events.',
    },
  ],
  'tops-shirts': [
    {
      slug: 't-shirt',
      name: 'T-shirt',
      order: 1,
      description: 'Casual knit top with short or long sleeves.',
    },
    {
      slug: 'blouse',
      name: 'Blouse',
      order: 2,
      description: 'Soft tailored top often worn as a dressy separate.',
    },
    {
      slug: 'crop-top',
      name: 'Crop top',
      order: 3,
      description: 'Short top designed to sit above the waistline.',
    },
    {
      slug: 'peplum-top',
      name: 'Peplum top',
      order: 4,
      description: 'Top with a flared waist extension.',
    },
    {
      slug: 'button-down-shirt',
      name: 'Button-down shirt',
      order: 5,
      description: 'Shirt with a front button placket and collar.',
    },
    {
      slug: 'dashiki-top',
      name: 'Dashiki top',
      order: 6,
      description: 'Loose dashiki-inspired upper garment.',
    },
    {
      slug: 'buba-top',
      name: 'Buba top',
      order: 7,
      description:
        'Traditional buba upper garment worn alone or with wrappers and sets.',
    },
  ],
  'trousers-shorts': [
    {
      slug: 'tailored-trousers',
      name: 'Tailored trousers',
      order: 1,
      description: 'Structured trousers with clean tailoring.',
    },
    {
      slug: 'wide-leg-trousers',
      name: 'Wide-leg trousers',
      order: 2,
      description: 'Trousers with a wide leg silhouette.',
    },
    {
      slug: 'palazzo-pants',
      name: 'Palazzo pants',
      order: 3,
      description: 'Loose, flowing wide-leg pants.',
    },
    {
      slug: 'chinos',
      name: 'Chinos',
      order: 4,
      description: 'Twill trousers with a clean casual finish.',
    },
    {
      slug: 'joggers',
      name: 'Joggers',
      order: 5,
      description: 'Relaxed trousers with elasticated or cuffed hems.',
    },
    {
      slug: 'shorts',
      name: 'Shorts',
      order: 6,
      description:
        'Short divided-leg garment ending above the knee or mid-thigh.',
    },
    {
      slug: 'culottes',
      name: 'Culottes',
      order: 7,
      description: 'Wide-leg cropped trousers with skirt-like movement.',
    },
  ],
  skirts: [
    {
      slug: 'pencil-skirt',
      name: 'Pencil skirt',
      order: 1,
      description: 'Straight, narrow skirt with a tailored fit.',
    },
    {
      slug: 'a-line-skirt',
      name: 'A-line skirt',
      order: 2,
      description: 'Skirt fitted at the waist and wider toward the hem.',
    },
    {
      slug: 'maxi-skirt',
      name: 'Maxi skirt',
      order: 3,
      description: 'Full-length skirt that reaches the ankle or floor.',
    },
    {
      slug: 'wrap-skirt',
      name: 'Wrap skirt',
      order: 4,
      description: 'Skirt formed by wrapping one panel over another.',
    },
    {
      slug: 'pleated-skirt',
      name: 'Pleated skirt',
      order: 5,
      description: 'Skirt with repeated folds for shape and movement.',
    },
  ],
  'suits-blazers': [
    {
      slug: 'blazer',
      name: 'Blazer',
      order: 1,
      description: 'Tailored jacket worn as a separate or part of a set.',
    },
    {
      slug: 'two-piece-suit',
      name: 'Two-piece suit',
      order: 2,
      description: 'Matching jacket and trousers or skirt.',
    },
    {
      slug: 'three-piece-suit',
      name: 'Three-piece suit',
      order: 3,
      description: 'Matching jacket, waistcoat, and trousers or skirt.',
    },
    {
      slug: 'tuxedo',
      name: 'Tuxedo',
      order: 4,
      description: 'Formal suit with dresswear finishing.',
    },
    {
      slug: 'waistcoat',
      name: 'Waistcoat',
      order: 5,
      description:
        'Sleeveless tailored vest worn over a shirt or under a jacket.',
    },
  ],
  'co-ord-sets': [
    {
      slug: 'two-piece-set',
      name: 'Two-piece set',
      order: 1,
      description: 'Matching two-piece outfit designed to be worn together.',
    },
    {
      slug: 'matching-top-trousers',
      name: 'Matching top and trousers',
      order: 2,
      description: 'Coordinated top and trouser set.',
    },
    {
      slug: 'matching-top-skirt',
      name: 'Matching top and skirt',
      order: 3,
      description: 'Coordinated top and skirt set.',
    },
    {
      slug: 'loungewear-set',
      name: 'Loungewear set',
      order: 4,
      description: 'Coordinated relaxed outfit set for comfort wear.',
    },
  ],
  outerwear: [
    {
      slug: 'jacket',
      name: 'Jacket',
      order: 1,
      description: 'Layering garment worn over an outfit.',
    },
    {
      slug: 'kimono',
      name: 'Kimono',
      order: 2,
      description: 'Open-front robe-like outer layer.',
    },
    {
      slug: 'cape',
      name: 'Cape',
      order: 3,
      description: 'Sleeveless outer garment draped over the shoulders.',
    },
    {
      slug: 'coat',
      name: 'Coat',
      order: 4,
      description: 'Longer outerwear garment for layering and coverage.',
    },
    {
      slug: 'shawl',
      name: 'Shawl',
      order: 5,
      description: 'Draped outer wrap worn around the shoulders.',
    },
  ],
  agbada: [
    {
      slug: 'grand-agbada',
      name: 'Grand agbada',
      order: 1,
      description: 'Full formal agbada with expansive robe proportions.',
    },
    {
      slug: 'casual-agbada',
      name: 'Casual agbada',
      order: 2,
      description: 'Simplified agbada garment for lighter wear.',
    },
    {
      slug: 'embroidered-agbada',
      name: 'Embroidered agbada',
      order: 3,
      description: 'Agbada featuring visible embroidery work.',
    },
    {
      slug: 'wedding-agbada',
      name: 'Wedding agbada',
      order: 4,
      description: 'Ceremonial agbada outfit designed as wedding attire.',
    },
  ],
  'senator-wear': [
    {
      slug: 'two-piece-senator',
      name: 'Two-piece senator',
      order: 1,
      description: 'Senator top and trouser set.',
    },
    {
      slug: 'long-sleeve-senator',
      name: 'Long-sleeve senator',
      order: 2,
      description: 'Senator outfit with a long-sleeve top.',
    },
    {
      slug: 'short-sleeve-senator',
      name: 'Short-sleeve senator',
      order: 3,
      description: 'Senator outfit with a short-sleeve top.',
    },
    {
      slug: 'embroidered-senator',
      name: 'Embroidered senator',
      order: 4,
      description: 'Senator outfit with embroidery detail.',
    },
  ],
  kaftans: [
    {
      slug: 'long-kaftan',
      name: 'Long kaftan',
      order: 1,
      description: 'Full-length kaftan garment.',
    },
    {
      slug: 'short-kaftan',
      name: 'Short kaftan',
      order: 2,
      description: 'Shorter kaftan garment.',
    },
    {
      slug: 'embroidered-kaftan',
      name: 'Embroidered kaftan',
      order: 3,
      description: 'Kaftan with embroidery detail.',
    },
    {
      slug: 'casual-kaftan',
      name: 'Casual kaftan',
      order: 4,
      description: 'Relaxed kaftan designed for lighter everyday wear.',
    },
  ],
  'buba-wrapper': [
    {
      slug: 'lace-buba-wrapper',
      name: 'Lace buba and wrapper',
      order: 1,
      description: 'Buba and wrapper set made with lace fabric.',
    },
    {
      slug: 'ankara-buba-wrapper',
      name: 'Ankara buba and wrapper',
      order: 2,
      description: 'Buba and wrapper set made with ankara fabric.',
    },
    {
      slug: 'aso-oke-buba-wrapper',
      name: 'Aso oke buba and wrapper',
      order: 3,
      description: 'Buba and wrapper set made with aso oke fabric.',
    },
    {
      slug: 'iro-and-buba',
      name: 'Iro and buba',
      order: 4,
      description: 'Traditional wrapper and buba outfit.',
    },
  ],
  'native-sets': [
    {
      slug: 'traditional-set',
      name: 'Traditional set',
      order: 1,
      description: 'Matching traditional outfit set.',
    },
    {
      slug: 'dashiki-set',
      name: 'Dashiki set',
      order: 2,
      description: 'Matching outfit set built around a dashiki garment.',
    },
    {
      slug: 'aso-oke-set',
      name: 'Aso oke set',
      order: 3,
      description: 'Matching outfit set made with aso oke fabric.',
    },
    {
      slug: 'adire-set',
      name: 'Adire set',
      order: 4,
      description: 'Matching outfit set made with adire fabric.',
    },
    {
      slug: 'isi-agu-set',
      name: 'Isi agu set',
      order: 5,
      description: 'Matching outfit set using isi agu textile or motif.',
    },
  ],
  'bridal-wear': [
    {
      slug: 'bridal-gown',
      name: 'Bridal gown',
      order: 1,
      description: 'Gown made for a bride.',
    },
    {
      slug: 'reception-dress',
      name: 'Reception dress',
      order: 2,
      description: 'Dress made for a wedding reception look.',
    },
    {
      slug: 'bridesmaid-dress',
      name: 'Bridesmaid dress',
      order: 3,
      description: 'Dress made for bridal party attendants.',
    },
    {
      slug: 'bridal-robe',
      name: 'Bridal robe',
      order: 4,
      description: 'Robe made for bridal preparation or ceremony styling.',
    },
    {
      slug: 'groom-traditional-set',
      name: 'Groom traditional set',
      order: 5,
      description: 'Traditional outfit set made for a groom.',
    },
  ],
};

// =====================
// Discovery Filter Dimensions
// =====================

export const DEFAULT_FILTER_DIMENSIONS: FilterDimensionSeed[] = [
  {
    slug: 'style',
    name: 'Style',
    description: 'Design aesthetic and styling direction.',
    order: 1,
    isMulti: true,
    appliesTo: CATALOG_FILTER_APPLIES_TO,
    values: [
      { slug: 'casual-streetwear', name: 'Casual / Streetwear', order: 1 },
      { slug: 'formal-corporate', name: 'Formal / Corporate', order: 2 },
      { slug: 'evening-luxury', name: 'Evening / Luxury', order: 3 },
      { slug: 'bridal-wedding', name: 'Bridal / Wedding', order: 4 },
      { slug: 'minimalist', name: 'Minimalist', order: 5 },
      { slug: 'modest', name: 'Modest', order: 6 },
      { slug: 'statement-bold', name: 'Statement / Bold', order: 7 },
      { slug: 'vintage-retro', name: 'Vintage / Retro', order: 8 },
      { slug: 'everyday', name: 'Everyday', order: 9 },
      { slug: 'contemporary', name: 'Contemporary', order: 10 },
    ],
  },
  {
    slug: 'heritage',
    name: 'Heritage',
    description:
      'Cultural influence, textile tradition, or heritage styling signal.',
    order: 2,
    isMulti: true,
    appliesTo: CATALOG_FILTER_APPLIES_TO,
    values: [
      { slug: 'african-cultural', name: 'African & Cultural', order: 1 },
      { slug: 'ankara', name: 'Ankara', order: 2 },
      { slug: 'aso-ebi', name: 'Aso Ebi', order: 3 },
      { slug: 'adire', name: 'Adire', order: 4 },
      { slug: 'lace', name: 'Lace', order: 5 },
      { slug: 'aso-oke', name: 'Aso Oke', order: 6 },
      { slug: 'kente', name: 'Kente', order: 7 },
      { slug: 'kampala', name: 'Kampala', order: 8 },
      { slug: 'dashiki', name: 'Dashiki', order: 9 },
      { slug: 'yoruba-traditional', name: 'Yoruba Traditional', order: 10 },
      { slug: 'igbo-traditional', name: 'Igbo Traditional', order: 11 },
      {
        slug: 'hausa-arewa-traditional',
        name: 'Hausa / Arewa Traditional',
        order: 12,
      },
      { slug: 'isi-agu', name: 'Isi Agu', order: 13 },
      {
        slug: 'coral-beads-royal-traditional',
        name: 'Coral Beads / Royal Traditional',
        order: 14,
      },
      { slug: 'afro-modern', name: 'Afro-Modern', order: 15 },
    ],
  },
  {
    slug: 'occasion',
    name: 'Occasion',
    description: 'Where or when the item would be worn.',
    order: 3,
    isMulti: true,
    appliesTo: CATALOG_FILTER_APPLIES_TO,
    values: [
      { slug: 'everyday', name: 'Everyday', order: 1 },
      { slug: 'office-work', name: 'Office / Work', order: 2 },
      { slug: 'wedding', name: 'Wedding', order: 3 },
      { slug: 'owambe-party', name: 'Owambe / Party', order: 4 },
      { slug: 'date-night', name: 'Date Night', order: 5 },
      { slug: 'religious-event', name: 'Religious Event', order: 6 },
      {
        slug: 'festival-cultural-event',
        name: 'Festival / Cultural Event',
        order: 7,
      },
      { slug: 'graduation', name: 'Graduation', order: 8 },
      { slug: 'birthday', name: 'Birthday', order: 9 },
      { slug: 'red-carpet', name: 'Red Carpet', order: 10 },
      { slug: 'travel-vacation', name: 'Travel / Vacation', order: 11 },
      { slug: 'naming-ceremony', name: 'Naming Ceremony', order: 12 },
      { slug: 'traditional-ceremony', name: 'Traditional Ceremony', order: 13 },
    ],
  },
  {
    slug: 'fabric',
    name: 'Fabric',
    description: 'Material or textile used in the item.',
    order: 4,
    isMulti: true,
    appliesTo: CATALOG_FILTER_APPLIES_TO,
    values: [
      { slug: 'ankara', name: 'Ankara', order: 1 },
      { slug: 'lace', name: 'Lace', order: 2 },
      { slug: 'silk', name: 'Silk', order: 3 },
      { slug: 'cotton', name: 'Cotton', order: 4 },
      { slug: 'linen', name: 'Linen', order: 5 },
      { slug: 'denim', name: 'Denim', order: 6 },
      { slug: 'chiffon', name: 'Chiffon', order: 7 },
      { slug: 'crepe', name: 'Crepe', order: 8 },
      { slug: 'velvet', name: 'Velvet', order: 9 },
      { slug: 'aso-oke', name: 'Aso Oke', order: 10 },
      { slug: 'adire', name: 'Adire', order: 11 },
      { slug: 'kente', name: 'Kente', order: 12 },
      { slug: 'satin', name: 'Satin', order: 13 },
      { slug: 'organza', name: 'Organza', order: 14 },
    ],
  },
  {
    slug: 'color-family',
    name: 'Color Family',
    description: 'Broad dominant color group.',
    order: 5,
    isMulti: true,
    appliesTo: CATALOG_FILTER_APPLIES_TO,
    values: [
      { slug: 'black', name: 'Black', order: 1 },
      { slug: 'white', name: 'White', order: 2 },
      { slug: 'neutral', name: 'Neutral', order: 3 },
      { slug: 'red', name: 'Red', order: 4 },
      { slug: 'blue', name: 'Blue', order: 5 },
      { slug: 'green', name: 'Green', order: 6 },
      { slug: 'yellow', name: 'Yellow', order: 7 },
      { slug: 'pink', name: 'Pink', order: 8 },
      { slug: 'purple', name: 'Purple', order: 9 },
      { slug: 'brown', name: 'Brown', order: 10 },
      { slug: 'gold', name: 'Gold', order: 11 },
      { slug: 'silver', name: 'Silver', order: 12 },
      { slug: 'multicolor', name: 'Multicolor', order: 13 },
      { slug: 'earth-tones', name: 'Earth Tones', order: 14 },
      { slug: 'pastels', name: 'Pastels', order: 15 },
    ],
  },
  {
    slug: 'fit',
    name: 'Fit',
    description: 'Discovery silhouette or shape signal.',
    order: 6,
    isMulti: true,
    appliesTo: CATALOG_FILTER_APPLIES_TO,
    values: [
      { slug: 'slim', name: 'Slim', order: 1 },
      { slug: 'regular', name: 'Regular', order: 2 },
      { slug: 'loose', name: 'Loose', order: 3 },
      { slug: 'oversized', name: 'Oversized', order: 4 },
      { slug: 'flowy', name: 'Flowy', order: 5 },
      { slug: 'structured', name: 'Structured', order: 6 },
      { slug: 'fitted', name: 'Fitted', order: 7 },
      { slug: 'relaxed', name: 'Relaxed', order: 8 },
    ],
  },
];

// =====================
// Filter -> Hashtag Suggestions
// =====================

export const FILTER_TAG_SUGGESTIONS: Record<string, string[]> = {
  // Style
  'casual-streetwear': ['streetwear', 'casual-style', 'daily-fit'],
  'formal-corporate': ['office-style', 'corporate-style', 'workwear'],
  'evening-luxury': ['eveningwear', 'luxury-style', 'glamour'],
  'bridal-wedding': ['bridal', 'wedding-guest', 'aso-ebi'],
  minimalist: ['minimalist-fashion', 'clean-lines'],
  modest: ['modest-fashion', 'covered-style'],
  'statement-bold': ['statement-piece', 'bold-style', 'standout-look'],
  'vintage-retro': ['vintage-style', 'retro-fashion'],
  contemporary: ['modern-fashion', 'contemporary-style'],

  // Heritage and fabric
  'african-cultural': [
    'african-fashion',
    'cultural-fashion',
    'traditional-wear',
  ],
  ankara: ['ankara-fashion', 'african-prints', 'modern-african'],
  'aso-ebi': ['aso-ebi', 'owambe', 'wedding-guest'],
  adire: ['adire', 'indigenous-craft', 'hand-dyed'],
  lace: ['lace-style', 'aso-ebi', 'elegant'],
  'aso-oke': ['aso-oke', 'yoruba-fashion', 'owambe'],
  kente: ['kente', 'ghanaian-fashion', 'woven-textiles'],
  kampala: ['kampala', 'hand-dyed', 'african-fashion'],
  dashiki: ['dashiki', 'afro-modern', 'modern-african'],
  'yoruba-traditional': ['yoruba-fashion', 'traditional-wear', 'owambe'],
  'igbo-traditional': ['igbo-fashion', 'isi-agu', 'traditional-wear'],
  'hausa-arewa-traditional': [
    'arewa-fashion',
    'hausa-fashion',
    'modest-fashion',
  ],
  'isi-agu': ['isi-agu', 'igbo-fashion', 'traditional-wear'],
  'coral-beads-royal-traditional': [
    'coral-beads',
    'royal-traditional',
    'traditional-wear',
  ],
  'afro-modern': ['afro-modern', 'modern-african', 'afro-fusion'],
  silk: ['silk-style', 'premium-fabric'],
  cotton: ['cotton-wear', 'comfortable-style'],
  linen: ['linen-style', 'summer-style'],
  denim: ['denim-style', 'casual-style'],
  chiffon: ['chiffon-style', 'soft-style'],
  crepe: ['crepe-fabric', 'elegant'],
  velvet: ['velvet-style', 'rich-texture'],
  satin: ['satin-style', 'eveningwear'],
  organza: ['organza-style', 'statement-piece'],

  // Occasion
  everyday: ['everyday-style', 'daily-wear', 'comfortable'],
  'office-work': ['office-style', 'work-outfit', 'corporate'],
  wedding: ['wedding-guest', 'bridal', 'aso-ebi'],
  'owambe-party': ['owambe', 'party-wear', 'aso-ebi'],
  'date-night': ['date-night', 'evening-look'],
  'religious-event': ['modest-fashion', 'sunday-best'],
  'festival-cultural-event': ['festival-fashion', 'cultural-fashion'],
  graduation: ['graduation-style', 'occasionwear'],
  birthday: ['birthday-look', 'party-wear'],
  'red-carpet': ['red-carpet', 'statement-piece'],
  'travel-vacation': ['vacation-style', 'travel-outfit'],
  'naming-ceremony': ['naming-ceremony', 'traditional-wear'],
  'traditional-ceremony': ['traditional-ceremony', 'cultural-fashion'],

  // Color and fit
  black: ['black-style', 'classic-look'],
  white: ['white-style', 'clean-look'],
  neutral: ['neutral-style', 'minimalist-fashion'],
  red: ['red-look', 'bold-style'],
  blue: ['blue-style', 'cool-tones'],
  green: ['green-style', 'earthy'],
  yellow: ['yellow-style', 'bright-look'],
  pink: ['pink-style', 'soft-tones'],
  purple: ['purple-style', 'royal-tones'],
  brown: ['brown-style', 'earth-tones'],
  gold: ['gold-fashion', 'luxury-style'],
  silver: ['silver-accents', 'metallic-style'],
  multicolor: ['multicolor', 'bold-prints'],
  'earth-tones': ['earth-tones', 'warm-palette'],
  pastels: ['pastel-colors', 'soft-tones'],
  slim: ['slim-fit', 'tailored-fit'],
  regular: ['regular-fit', 'classic-fit'],
  loose: ['loose-fit', 'relaxed-style'],
  oversized: ['oversized-fit', 'streetwear'],
  flowy: ['flowy-fit', 'soft-silhouette'],
  structured: ['structured-fit', 'tailored-look'],
  fitted: ['fitted', 'body-skimming'],
  relaxed: ['relaxed-fit', 'comfortable'],
};

// =====================
// Legacy slugs for deactivation only
// =====================

export const LEGACY_CATEGORY_SLUGS = [
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
];

export const LEGACY_CATEGORY_TYPE_SLUGS = [
  'dresses-gowns',
  'tops-blouses',
  'skirts-wraps',
  'pants-trousers-w',
  'outerwear-w',
  'plus-size-curvy',
  'jumpsuits-rompers',
  'shirts-tops-m',
  'trousers-chinos',
  'agbada-kaftans',
  'suits-blazers',
  'streetwear-m',
  'shorts-casual-m',
  'bags-purses',
  'shoes-sandals',
  'jewelry',
  'headwear-scarves',
  'belts-ties',
  'traditional-outfits',
  'fusion-styles',
  'wedding-events',
  'childrens-wear',
  'top',
  'trouser',
  'gown',
  'skirt',
  'jacket',
  'jumpsuit',
  'shorts',
  'dress',
  'shirt',
  'blouse',
  'kaftan',
  'agbada',
  'aso-oke-wear',
  'adire-wear',
  'native-wear',
  'casual-wear',
  'formal-wear',
  'accessories',
  'footwear',
  'plus-size',
  'curvy',
  'custom',
  'bespoke',
  'luxury',
];

export const LEGACY_FILTER_DIMENSION_SLUGS = [
  'fabric-type',
  'fit-shape',
  'designer-location',
  'price-range',
];
