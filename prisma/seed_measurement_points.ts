import { PrismaClient } from '@prisma/client';

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
  gender: 'MEN' | 'WOMEN';
  sortOrder: number;
};

const MEN_POINTS: Omit<PointSeed, 'gender' | 'sortOrder'>[] = [
  { key: 'MEN_NECK', label: 'Neck', description: 'Around base of neck where collar sits', category: 'UPPER_BODY' },
  { key: 'MEN_SHOULDER', label: 'Shoulder', description: 'Edge of one shoulder bone to the other, across back', category: 'UPPER_BODY' },
  { key: 'MEN_CHEST', label: 'Chest', description: 'Around fullest part of chest, under arms', category: 'UPPER_BODY' },
  { key: 'MEN_STOMACH_BELLY', label: 'Stomach/Belly', description: 'Around widest part of abdomen', category: 'UPPER_BODY' },
  { key: 'MEN_WAIST', label: 'Waist', description: 'At natural waistline (narrowest part of torso)', category: 'UPPER_BODY' },
  { key: 'MEN_HIP', label: 'Hip', description: 'Around fullest part of hips/buttocks', category: 'LOWER_BODY' },
  { key: 'MEN_ARM_HOLE', label: 'Arm Hole', description: 'Around the armpit/armhole circumference', category: 'ARMS' },
  { key: 'MEN_BICEP', label: 'Bicep', description: 'Around fullest part of upper arm', category: 'ARMS' },
  { key: 'MEN_ELBOW', label: 'Elbow', description: 'Around the elbow', category: 'ARMS' },
  { key: 'MEN_WRIST', label: 'Wrist', description: 'Around the wrist', category: 'ARMS' },
  { key: 'MEN_SLEEVE_LENGTH', label: 'Sleeve Length', description: 'Shoulder point to wrist bone', category: 'ARMS' },
  { key: 'MEN_SHORT_SLEEVE_LENGTH', label: 'Short Sleeve Length', description: 'Shoulder point to desired short sleeve end', category: 'ARMS' },
  { key: 'MEN_ROUND_SLEEVE', label: 'Round Sleeve', description: 'Circumference of sleeve opening', category: 'ARMS' },
  { key: 'MEN_SHIRT_TOP_LENGTH', label: 'Shirt/Top Length', description: 'Base of neck to desired hem', category: 'LENGTH' },
  { key: 'MEN_BACK_LENGTH_NAPE_TO_WAIST', label: 'Back Length (Nape to Waist)', description: 'Nape of neck to natural waistline', category: 'LENGTH' },
  { key: 'MEN_JACKET_LENGTH', label: 'Jacket Length', description: 'Nape of neck to desired jacket hem', category: 'LENGTH' },
  { key: 'MEN_TROUSER_LENGTH_OUTSEAM', label: 'Trouser Length (Outseam)', description: 'Waist to ankle, along outside of leg', category: 'LOWER_BODY' },
  { key: 'MEN_INSEAM', label: 'Inseam', description: 'Crotch to ankle, inner leg', category: 'LOWER_BODY' },
  { key: 'MEN_THIGH', label: 'Thigh', description: 'Around fullest part of thigh', category: 'LOWER_BODY' },
  { key: 'MEN_KNEE_CIRCUMFERENCE', label: 'Knee Circumference', description: 'Around the knee', category: 'LOWER_BODY' },
  { key: 'MEN_CALF', label: 'Calf', description: 'Around widest part of calf', category: 'LOWER_BODY' },
  { key: 'MEN_ANKLE_CIRCUMFERENCE', label: 'Ankle Circumference', description: 'Around the ankle', category: 'LOWER_BODY' },
  { key: 'MEN_CROTCH_U_RISE', label: 'Crotch/U-Rise', description: 'Front waistband through crotch to back waistband', category: 'LOWER_BODY' },
  { key: 'MEN_HEIGHT', label: 'Height', description: 'Overall body height', category: 'GENERAL' },
  { key: 'MEN_WEIGHT', label: 'Weight', description: 'Body weight (kg or lbs)', category: 'GENERAL' },
  { key: 'MEN_CAP_HEAD_CIRCUMFERENCE', label: 'Cap/Head Circumference', description: 'Around widest part of head (for caps/hats)', category: 'ACCESSORIES' },
];

const WOMEN_POINTS: Omit<PointSeed, 'gender' | 'sortOrder'>[] = [
  { key: 'WOMEN_NECK', label: 'Neck', description: 'Around base of neck where collar sits', category: 'UPPER_BODY' },
  { key: 'WOMEN_SHOULDER_WIDTH', label: 'Shoulder Width', description: 'Edge of one shoulder bone to the other, across back', category: 'UPPER_BODY' },
  { key: 'WOMEN_FRONT_SHOULDER', label: 'Front Shoulder', description: 'Across chest, shoulder point to shoulder point', category: 'UPPER_BODY' },
  { key: 'WOMEN_CHEST_FULL_BUST', label: 'Chest/Full Bust', description: 'Around fullest part of bust, parallel to floor', category: 'UPPER_BODY' },
  { key: 'WOMEN_HIGH_BUST', label: 'High Bust', description: 'Above fullest part, at crook of armpits', category: 'UPPER_BODY' },
  { key: 'WOMEN_UNDERBUST', label: 'Underbust', description: 'Just below the breast fold', category: 'UPPER_BODY' },
  { key: 'WOMEN_BUST_POINT_TO_BUST_POINT', label: 'Bust Point to Bust Point', description: 'Distance between bust apex points', category: 'UPPER_BODY' },
  { key: 'WOMEN_BUST_HEIGHT_APEX', label: 'Bust Height/Apex', description: 'Shoulder to bust point vertically', category: 'UPPER_BODY' },
  { key: 'WOMEN_WAIST', label: 'Waist', description: 'At natural waistline (narrowest torso)', category: 'UPPER_BODY' },
  { key: 'WOMEN_UPPER_HIP_HIGH_HIP', label: 'Upper Hip (High Hip)', description: '~3 inches below waist', category: 'UPPER_BODY' },
  { key: 'WOMEN_HIP', label: 'Hip', description: 'Around fullest part of hips/buttocks', category: 'LOWER_BODY' },
  { key: 'WOMEN_STOMACH_WIDEST_ABDOMEN', label: 'Stomach/Widest Abdomen', description: 'Widest part of abdomen (if different from waist)', category: 'UPPER_BODY' },
  { key: 'WOMEN_ARM_HOLE_DEPTH', label: 'Arm Hole Depth', description: 'Top of shoulder to bottom of armhole', category: 'ARMS' },
  { key: 'WOMEN_ARM_HOLE_CIRCUMFERENCE', label: 'Arm Hole Circumference', description: 'Around the armhole', category: 'ARMS' },
  { key: 'WOMEN_BICEP', label: 'Bicep', description: 'Around fullest part of upper arm', category: 'ARMS' },
  { key: 'WOMEN_ELBOW', label: 'Elbow', description: 'Around the elbow', category: 'ARMS' },
  { key: 'WOMEN_WRIST', label: 'Wrist', description: 'Around the wrist', category: 'ARMS' },
  { key: 'WOMEN_SLEEVE_LENGTH_LONG', label: 'Sleeve Length (Long)', description: 'Shoulder to wrist', category: 'ARMS' },
  { key: 'WOMEN_SLEEVE_LENGTH_SHORT', label: 'Sleeve Length (Short)', description: 'Shoulder to desired short sleeve end', category: 'ARMS' },
  { key: 'WOMEN_ROUND_SLEEVE', label: 'Round Sleeve', description: 'Circumference of sleeve opening', category: 'ARMS' },
  { key: 'WOMEN_BACK_LENGTH_NAPE_TO_WAIST', label: 'Back Length (Nape to Waist)', description: 'Nape of neck to waistline', category: 'LENGTH' },
  { key: 'WOMEN_FRONT_LENGTH_SHOULDER_TO_WAIST', label: 'Front Length (Shoulder to Waist)', description: 'Shoulder through bust to waist', category: 'LENGTH' },
  { key: 'WOMEN_DRESS_TOP_LENGTH', label: 'Dress/Top Length', description: 'From shoulder to desired hem', category: 'LENGTH' },
  { key: 'WOMEN_SKIRT_LENGTH', label: 'Skirt Length', description: 'Waist to desired hem', category: 'LENGTH' },
  { key: 'WOMEN_TROUSER_LENGTH_OUTSEAM', label: 'Trouser Length (Outseam)', description: 'Waist to ankle', category: 'LOWER_BODY' },
  { key: 'WOMEN_INSEAM', label: 'Inseam', description: 'Crotch to ankle', category: 'LOWER_BODY' },
  { key: 'WOMEN_THIGH', label: 'Thigh', description: 'Around fullest part of thigh', category: 'LOWER_BODY' },
  { key: 'WOMEN_KNEE_CIRCUMFERENCE', label: 'Knee Circumference', description: 'Around the knee', category: 'LOWER_BODY' },
  { key: 'WOMEN_CALF', label: 'Calf', description: 'Around fullest part of calf', category: 'LOWER_BODY' },
  { key: 'WOMEN_ANKLE_CIRCUMFERENCE', label: 'Ankle Circumference', description: 'Around the ankle', category: 'LOWER_BODY' },
  { key: 'WOMEN_CROTCH_U_RISE', label: 'Crotch/U-Rise', description: 'Front waist through crotch to back waist', category: 'LOWER_BODY' },
  { key: 'WOMEN_WAIST_TO_HIP_LENGTH', label: 'Waist to Hip Length', description: 'Ensures proper fit between waist and hips', category: 'LOWER_BODY' },
  { key: 'WOMEN_WAIST_TO_KNEE_LENGTH', label: 'Waist to Knee Length', description: 'From waist to knee', category: 'LOWER_BODY' },
  { key: 'WOMEN_HEIGHT', label: 'Height', description: 'Overall body height', category: 'GENERAL' },
  { key: 'WOMEN_WEIGHT', label: 'Weight', description: 'Body weight (kg or lbs)', category: 'GENERAL' },
  { key: 'WOMEN_CAP_HEAD_CIRCUMFERENCE', label: 'Cap/Head Circumference', description: 'Around widest part of head', category: 'ACCESSORIES' },
];

function rangeFor(point: PointSeed): {
  minValueCm: number;
  maxValueCm: number;
  minValueChildCm: number;
  maxValueChildCm: number;
} {
  if (point.key.endsWith('WEIGHT')) {
    return { minValueCm: 25, maxValueCm: 250, minValueChildCm: 10, maxValueChildCm: 120 };
  }
  if (point.key.endsWith('HEIGHT')) {
    return { minValueCm: 120, maxValueCm: 230, minValueChildCm: 60, maxValueChildCm: 190 };
  }
  return { minValueCm: 10, maxValueCm: 220, minValueChildCm: 8, maxValueChildCm: 180 };
}

function buildSeedPoints(): PointSeed[] {
  const men = MEN_POINTS.map((point, index) => ({
    ...point,
    gender: 'MEN' as const,
    sortOrder: index + 1,
  }));

  const women = WOMEN_POINTS.map((point, index) => ({
    ...point,
    gender: 'WOMEN' as const,
    sortOrder: index + 1,
  }));

  return [...men, ...women];
}

export async function seedMeasurementPoints(prisma: PrismaClient): Promise<void> {
  const points = buildSeedPoints();

  for (const point of points) {
    const range = rangeFor(point);

    await (prisma as any).measurementPoint.upsert({
      where: { key: point.key },
      update: {
        label: point.label,
        description: point.description,
        category: point.category,
        gender: point.gender,
        source: 'SYSTEM',
        status: 'APPROVED_GLOBAL',
        sortOrder: point.sortOrder,
        isActive: true,
        ...range,
      },
      create: {
        key: point.key,
        label: point.label,
        description: point.description,
        category: point.category,
        gender: point.gender,
        source: 'SYSTEM',
        status: 'APPROVED_GLOBAL',
        sortOrder: point.sortOrder,
        isActive: true,
        ...range,
      },
    });
  }

  console.log(`Seeded measurement points: ${points.length}`);
}
