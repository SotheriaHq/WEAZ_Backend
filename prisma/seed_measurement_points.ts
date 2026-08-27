import { PrismaClient } from '@prisma/client';

/**
 * The measurement registry is ONE universal list — no gender split, no duplicates.
 *
 * It used to be seeded as two parallel sets (MEN_* and WOMEN_*), which produced
 * 62 rows where 18 labels were byte-identical across the two ("Bicep", "Calf",
 * "Neck", "Inseam"…) and several more were the same measurement under a
 * different name ("Arm Hole"/"Arm Hole Circumference", "Shoulder"/"Shoulder
 * Width", "Sleeve Length"/"Sleeve Length (Long)", "Stomach/Belly"/"Stomach/
 * Widest Abdomen"). A brand drafting a men's piece was therefore *hidden* from
 * measurements that apply to any body, and the two halves could drift apart
 * independently. `MeasurementPointsService.normalizeDisplayLabel()` existed only
 * to strip the MEN_/WOMEN_ prefix back off at display time — a symptom of this.
 *
 * Anatomy does not partition measurements by the gender of the wearer: a bust
 * apex measurement is needed to draft any fitted bodice, and a neck girth is a
 * neck girth. So every point below is seeded with `gender: null`, which
 * `getAll()` already treats as "always in scope" for every gender filter — one
 * registry, identical for design creation and product creation.
 *
 * Contents follow ISO 8559-1:2017's anthropometric groups (vertical / girth /
 * length / breadth / depth) cross-checked against bespoke tailoring and
 * dressmaking measurement guides. Two deliberate calls:
 *   - **Weight is NOT here.** ISO 8559 defines body *dimensions*; weight is not
 *     one, and drafting guides never take it. It only appears in ready-to-wear
 *     size-prediction calculators, which is not what this registry feeds.
 *   - **Wrist IS here.** It is a standard bespoke shirt/jacket measurement
 *     (cuff sizing), not a vestigial entry.
 */

type PointSeed = {
  key: string;
  label: string;
  description: string;
  category:
    | 'UPPER_BODY'
    | 'ARMS'
    | 'LOWER_BODY'
    | 'LENGTH'
    | 'GENERAL'
    | 'ACCESSORIES';
  /** Plausible adult range in cm; used for input validation. */
  min: number;
  max: number;
  /** Plausible child range in cm. */
  childMin: number;
  childMax: number;
};

const POINTS: PointSeed[] = [
  // ── General (ISO vertical dimensions) ───────────────────────────────────
  { key: 'HEIGHT', label: 'Height', description: 'Total vertical height from the crown of the head to the floor, standing upright without shoes', category: 'GENERAL', min: 120, max: 230, childMin: 60, childMax: 190 },

  // ── Upper body (ISO girth / breadth / depth) ────────────────────────────
  { key: 'NECK', label: 'Neck', description: 'Around the base of the neck, where a collar sits', category: 'UPPER_BODY', min: 25, max: 60, childMin: 18, childMax: 45 },
  { key: 'SHOULDER_WIDTH', label: 'Shoulder Width', description: 'Across the back, from one shoulder point to the other', category: 'UPPER_BODY', min: 25, max: 65, childMin: 18, childMax: 50 },
  { key: 'ACROSS_FRONT', label: 'Across Front', description: 'Across the chest, from armhole crease to armhole crease', category: 'UPPER_BODY', min: 22, max: 60, childMin: 15, childMax: 45 },
  { key: 'ACROSS_BACK', label: 'Across Back', description: 'Across the back at mid-armhole, armhole crease to armhole crease', category: 'UPPER_BODY', min: 25, max: 62, childMin: 18, childMax: 48 },
  { key: 'CHEST_BUST', label: 'Chest / Bust', description: 'Around the fullest part of the chest or bust, parallel to the floor', category: 'UPPER_BODY', min: 50, max: 180, childMin: 40, childMax: 120 },
  { key: 'HIGH_BUST', label: 'High Bust', description: 'Above the fullest part, straight across at the crook of the armpits', category: 'UPPER_BODY', min: 50, max: 170, childMin: 40, childMax: 115 },
  { key: 'UNDERBUST', label: 'Underbust', description: 'Directly below the breast fold, where a band would sit', category: 'UPPER_BODY', min: 45, max: 160, childMin: 38, childMax: 110 },
  { key: 'BUST_POINT_TO_BUST_POINT', label: 'Bust Point to Bust Point', description: 'Horizontal distance between the two bust apex points', category: 'UPPER_BODY', min: 10, max: 35, childMin: 8, childMax: 25 },
  { key: 'BUST_APEX_HEIGHT', label: 'Bust Height (Apex)', description: 'Shoulder point straight down to the bust apex', category: 'UPPER_BODY', min: 15, max: 45, childMin: 10, childMax: 35 },
  { key: 'WAIST', label: 'Waist', description: 'At the natural waistline, the narrowest part of the torso', category: 'UPPER_BODY', min: 40, max: 180, childMin: 35, childMax: 120 },
  { key: 'STOMACH', label: 'Stomach / Widest Abdomen', description: 'Around the widest part of the abdomen', category: 'UPPER_BODY', min: 45, max: 190, childMin: 35, childMax: 125 },
  { key: 'UPPER_HIP', label: 'Upper Hip (High Hip)', description: 'Around the body roughly 8 cm below the natural waist', category: 'UPPER_BODY', min: 50, max: 190, childMin: 40, childMax: 125 },

  // ── Arms ────────────────────────────────────────────────────────────────
  { key: 'ARMHOLE', label: 'Armhole', description: 'Around the armhole, through the armpit and over the shoulder point', category: 'ARMS', min: 25, max: 70, childMin: 18, childMax: 50 },
  { key: 'ARMHOLE_DEPTH', label: 'Armhole Depth', description: 'Shoulder point down to the underarm level', category: 'ARMS', min: 10, max: 35, childMin: 7, childMax: 26 },
  { key: 'BICEP', label: 'Bicep', description: 'Around the fullest part of the upper arm', category: 'ARMS', min: 15, max: 60, childMin: 10, childMax: 40 },
  { key: 'ELBOW', label: 'Elbow', description: 'Around the elbow, arm slightly bent', category: 'ARMS', min: 15, max: 50, childMin: 10, childMax: 35 },
  { key: 'WRIST', label: 'Wrist', description: 'Around the wrist bone, where a cuff closes', category: 'ARMS', min: 10, max: 30, childMin: 8, childMax: 22 },
  { key: 'SLEEVE_LENGTH_LONG', label: 'Sleeve Length (Long)', description: 'Shoulder point, along the arm, to the wrist bone', category: 'ARMS', min: 30, max: 80, childMin: 18, childMax: 60 },
  { key: 'SLEEVE_LENGTH_SHORT', label: 'Sleeve Length (Short)', description: 'Shoulder point to the desired short-sleeve hem', category: 'ARMS', min: 8, max: 45, childMin: 5, childMax: 32 },
  { key: 'SLEEVE_OPENING', label: 'Sleeve Opening', description: 'Circumference of the finished sleeve hem', category: 'ARMS', min: 10, max: 50, childMin: 8, childMax: 35 },

  // ── Lower body ──────────────────────────────────────────────────────────
  { key: 'HIP_SEAT', label: 'Hip / Seat', description: 'Around the fullest part of the hips and seat', category: 'LOWER_BODY', min: 50, max: 200, childMin: 40, childMax: 130 },
  { key: 'THIGH', label: 'Thigh', description: 'Around the fullest part of the thigh', category: 'LOWER_BODY', min: 25, max: 100, childMin: 18, childMax: 70 },
  { key: 'KNEE', label: 'Knee', description: 'Around the knee', category: 'LOWER_BODY', min: 20, max: 70, childMin: 15, childMax: 50 },
  { key: 'CALF', label: 'Calf', description: 'Around the widest part of the calf', category: 'LOWER_BODY', min: 18, max: 70, childMin: 12, childMax: 50 },
  { key: 'ANKLE', label: 'Ankle', description: 'Around the ankle bone', category: 'LOWER_BODY', min: 15, max: 45, childMin: 10, childMax: 32 },
  { key: 'CROTCH_RISE', label: 'Crotch / Rise', description: 'Front waistband, through the crotch, to the back waistband', category: 'LOWER_BODY', min: 40, max: 110, childMin: 25, childMax: 80 },
  { key: 'INSEAM', label: 'Inseam', description: 'Crotch to ankle, along the inside of the leg', category: 'LOWER_BODY', min: 40, max: 110, childMin: 20, childMax: 85 },
  { key: 'OUTSEAM', label: 'Outseam (Trouser Length)', description: 'Waist to ankle, along the outside of the leg', category: 'LOWER_BODY', min: 60, max: 140, childMin: 30, childMax: 110 },
  { key: 'WAIST_TO_HIP', label: 'Waist to Hip Length', description: 'Natural waist down to the fullest part of the hip', category: 'LOWER_BODY', min: 10, max: 40, childMin: 7, childMax: 30 },
  { key: 'WAIST_TO_KNEE', label: 'Waist to Knee Length', description: 'Natural waist down to the knee', category: 'LOWER_BODY', min: 35, max: 85, childMin: 20, childMax: 65 },

  // ── Garment lengths ─────────────────────────────────────────────────────
  { key: 'NAPE_TO_WAIST', label: 'Nape to Waist (Back Length)', description: 'Nape of the neck down the spine to the natural waist', category: 'LENGTH', min: 25, max: 60, childMin: 15, childMax: 45 },
  { key: 'FRONT_LENGTH_SHOULDER_TO_WAIST', label: 'Front Length (Shoulder to Waist)', description: 'Shoulder point at the neck, over the front, to the natural waist', category: 'LENGTH', min: 25, max: 60, childMin: 15, childMax: 45 },
  { key: 'TOP_LENGTH', label: 'Shirt / Top Length', description: 'Base of the neck to the desired top hem', category: 'LENGTH', min: 35, max: 110, childMin: 20, childMax: 80 },
  { key: 'DRESS_LENGTH', label: 'Dress Length', description: 'Shoulder to the desired dress hem', category: 'LENGTH', min: 60, max: 180, childMin: 30, childMax: 130 },
  { key: 'SKIRT_LENGTH', label: 'Skirt Length', description: 'Waist to the desired skirt hem', category: 'LENGTH', min: 20, max: 130, childMin: 15, childMax: 95 },
  { key: 'JACKET_LENGTH', label: 'Jacket Length', description: 'Base of the neck to the desired jacket hem', category: 'LENGTH', min: 40, max: 130, childMin: 25, childMax: 95 },

  // ── Accessories ─────────────────────────────────────────────────────────
  { key: 'HEAD_CIRCUMFERENCE', label: 'Head Circumference', description: 'Around the widest part of the head, for caps and hats', category: 'ACCESSORIES', min: 35, max: 70, childMin: 30, childMax: 60 },
];

export const MEASUREMENT_POINT_KEYS = POINTS.map((point) => point.key);

export async function seedMeasurementPoints(prisma: PrismaClient): Promise<void> {
  for (const [index, point] of POINTS.entries()) {
    const values = {
      label: point.label,
      description: point.description,
      category: point.category,
      // Universal by design — see the file header. `getAll()` returns
      // null-gender points for every gender filter.
      gender: null,
      source: 'SYSTEM' as const,
      status: 'APPROVED_GLOBAL' as const,
      sortOrder: index + 1,
      isActive: true,
      minValueCm: point.min,
      maxValueCm: point.max,
      minValueChildCm: point.childMin,
      maxValueChildCm: point.childMax,
    };

    await (prisma as any).measurementPoint.upsert({
      where: { key: point.key },
      update: values,
      create: { key: point.key, ...values },
    });
  }

  // Retire any SYSTEM point outside the canonical set — chiefly the legacy
  // MEN_*/WOMEN_* pairs this list replaces. Deactivated rather than deleted so
  // that any size chart or saved configuration still referencing one keeps its
  // foreign key; deactivated points drop out of `getAll()`.
  const retired = await (prisma as any).measurementPoint.updateMany({
    where: {
      source: 'SYSTEM',
      key: { notIn: MEASUREMENT_POINT_KEYS },
      isActive: true,
    },
    data: { isActive: false },
  });

  console.log(
    `Seeded measurement points: ${POINTS.length} canonical (retired ${retired.count} legacy).`,
  );
}
