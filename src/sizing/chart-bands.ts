/**
 * Letter-code body bands the engine designates against.
 *
 * Operational chart rows in the database still carry per-size ranges, including
 * length measurements. Those rows are a brand/region GRADE. The letter on a
 * shopper's profile is a SIZE DESIGNATION, and ISO 8559-2 / EN 13402 / ASTM
 * D6240 publish that designation by primary girth, separately for men and
 * women, and with different US vs European groupings.
 *
 * Applied only to regional / international fallback charts — a product that
 * ships its own chart keeps the brand's numbers.
 *
 * Sources:
 * - EN 13402-3 letter codes (men chest, women bust)
 * - ASTM D6240 grouped alpha (US men)
 * - ISO 8559-2: primary dimension designates; sleeve/inseam/height are length
 *   class, not girth size
 */

import type { SizingBody } from '../common/profile-gender';

export type GirthBand = {
  chestBust: [number, number];
  waist: [number, number];
  hipSeat: [number, number];
  neckCollar?: [number, number];
};

const ALPHA_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'] as const;
export type AlphaSize = (typeof ALPHA_ORDER)[number];

/**
 * EN 13402-3 Table 42 (men) and the matching women's letter-code table.
 * Each letter combines two 4 cm numeric steps.
 */
const EN_MEN: Record<AlphaSize, GirthBand> = {
  XS: { chestBust: [78, 86], waist: [66, 74], hipSeat: [78, 86], neckCollar: [35, 37] },
  S: { chestBust: [86, 94], waist: [74, 82], hipSeat: [86, 94], neckCollar: [37, 39] },
  M: { chestBust: [94, 102], waist: [82, 90], hipSeat: [94, 102], neckCollar: [39, 41] },
  L: { chestBust: [102, 110], waist: [90, 98], hipSeat: [102, 110], neckCollar: [41, 43] },
  XL: { chestBust: [110, 118], waist: [98, 106], hipSeat: [110, 118], neckCollar: [43, 45] },
  XXL: { chestBust: [118, 129], waist: [106, 117], hipSeat: [118, 129], neckCollar: [45, 47] },
  '3XL': { chestBust: [129, 141], waist: [117, 129], hipSeat: [129, 141], neckCollar: [47, 49] },
  '4XL': { chestBust: [141, 154], waist: [129, 142], hipSeat: [141, 154], neckCollar: [49, 52] },
};

const EN_WOMEN: Record<AlphaSize, GirthBand> = {
  XS: { chestBust: [74, 82], waist: [58, 66], hipSeat: [82, 90], neckCollar: [31, 33] },
  S: { chestBust: [82, 90], waist: [66, 74], hipSeat: [90, 98], neckCollar: [33, 35] },
  M: { chestBust: [90, 98], waist: [74, 82], hipSeat: [98, 106], neckCollar: [35, 37] },
  L: { chestBust: [98, 106], waist: [82, 90], hipSeat: [106, 114], neckCollar: [37, 39] },
  XL: { chestBust: [106, 114], waist: [90, 98], hipSeat: [114, 122], neckCollar: [39, 41] },
  XXL: { chestBust: [114, 122], waist: [98, 106], hipSeat: [122, 130], neckCollar: [41, 43] },
  '3XL': { chestBust: [122, 130], waist: [106, 114], hipSeat: [130, 138], neckCollar: [43, 45] },
  '4XL': { chestBust: [130, 143], waist: [114, 126], hipSeat: [138, 152], neckCollar: [45, 48] },
};

/**
 * ASTM D6240 grouped into the same alpha letters US retail actually prints.
 * A 50–52" (127–132 cm) chest is US XXL, not 3XL — that mismatch is how a
 * shopper who buys XXL was shown 3XL.
 */
const US_MEN: Record<AlphaSize, GirthBand> = {
  XS: { chestBust: [81, 86], waist: [66, 71], hipSeat: [81, 86], neckCollar: [35, 37] },
  S: { chestBust: [86, 94], waist: [71, 79], hipSeat: [86, 94], neckCollar: [37, 39] },
  M: { chestBust: [97, 104], waist: [81, 89], hipSeat: [97, 104], neckCollar: [39, 41] },
  L: { chestBust: [107, 114], waist: [91, 100], hipSeat: [107, 114], neckCollar: [41, 43] },
  XL: { chestBust: [117, 124], waist: [103, 112], hipSeat: [117, 124], neckCollar: [43, 45] },
  XXL: { chestBust: [127, 135], waist: [116, 126], hipSeat: [127, 135], neckCollar: [45, 47] },
  '3XL': { chestBust: [137, 145], waist: [130, 142], hipSeat: [137, 145], neckCollar: [47, 49] },
  '4XL': { chestBust: [147, 154], waist: [147, 157], hipSeat: [147, 154], neckCollar: [49, 52] },
};

const US_WOMEN: Record<AlphaSize, GirthBand> = {
  XS: { chestBust: [76, 82], waist: [58, 64], hipSeat: [84, 90], neckCollar: [31, 33] },
  S: { chestBust: [82, 88], waist: [64, 70], hipSeat: [90, 96], neckCollar: [33, 35] },
  M: { chestBust: [88, 94], waist: [70, 76], hipSeat: [96, 102], neckCollar: [35, 37] },
  L: { chestBust: [96, 102], waist: [78, 86], hipSeat: [104, 110], neckCollar: [37, 39] },
  XL: { chestBust: [104, 110], waist: [88, 96], hipSeat: [112, 118], neckCollar: [39, 41] },
  XXL: { chestBust: [112, 118], waist: [98, 106], hipSeat: [120, 126], neckCollar: [41, 43] },
  '3XL': { chestBust: [120, 128], waist: [108, 116], hipSeat: [128, 136], neckCollar: [43, 45] },
  '4XL': { chestBust: [130, 140], waist: [118, 128], hipSeat: [138, 148], neckCollar: [45, 48] },
};

export function bandsFor(
  region: string,
  body: SizingBody,
): Record<AlphaSize, GirthBand> {
  const isUs = region === 'US';
  if (body === 'WOMEN') return isUs ? US_WOMEN : EN_WOMEN;
  // MEN and UNISEX share the men's letter codes: unisex alpha in the industry
  // is a men's chest ladder. WOMEN is the only table that designates by bust.
  return isUs ? US_MEN : EN_MEN;
}

export function isAlphaSize(label: string): label is AlphaSize {
  return (ALPHA_ORDER as readonly string[]).includes(label);
}

/**
 * Overlay standard designation bands onto fallback chart rows.
 *
 * Length columns (sleeve, inseam, height, shoulder) are left on the row —
 * they qualify a length class, they do not rename the size.
 */
export function applyBodyBands<T extends Record<string, any>>(
  rows: T[],
  region: string,
  body: SizingBody,
): T[] {
  const table = bandsFor(region, body);
  return rows.map((row) => {
    const label = String(row.sizeLabel ?? '');
    if (!isAlphaSize(label)) return row;
    const band = table[label];
    return {
      ...row,
      chestBustMinCm: band.chestBust[0],
      chestBustMaxCm: band.chestBust[1],
      waistMinCm: band.waist[0],
      waistMaxCm: band.waist[1],
      hipSeatMinCm: band.hipSeat[0],
      hipSeatMaxCm: band.hipSeat[1],
      ...(band.neckCollar
        ? {
            neckCollarMinCm: band.neckCollar[0],
            neckCollarMaxCm: band.neckCollar[1],
          }
        : {}),
    };
  });
}

export function sleeveLengthClass(sleeveCm: number | null | undefined): 'SHORT' | 'REGULAR' | 'LONG' | null {
  if (sleeveCm == null || !Number.isFinite(sleeveCm)) return null;
  if (sleeveCm < 58) return 'SHORT';
  if (sleeveCm > 66) return 'LONG';
  return 'REGULAR';
}

export function inseamLengthClass(inseamCm: number | null | undefined): 'SHORT' | 'REGULAR' | 'LONG' | null {
  if (inseamCm == null || !Number.isFinite(inseamCm)) return null;
  if (inseamCm < 74) return 'SHORT';
  if (inseamCm > 84) return 'LONG';
  return 'REGULAR';
}
