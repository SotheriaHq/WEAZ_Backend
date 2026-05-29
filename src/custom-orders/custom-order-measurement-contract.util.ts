import { CollectionType, CustomOrderSourceType, Gender } from '@prisma/client';

export type SourceMeasurementContractProfile = {
  sourceType: CustomOrderSourceType;
  categoryTypeSlug?: string | null;
  collectionType?: CollectionType | null;
  customGender?: Gender | null;
};

const MEN_UPPER_BODY_TEMPLATE = [
  'MEN_NECK',
  'MEN_SHOULDER',
  'MEN_CHEST',
  'MEN_STOMACH_BELLY',
  'MEN_WAIST',
  'MEN_HIP',
  'MEN_ARM_HOLE',
  'MEN_WRIST',
  'MEN_SLEEVE_LENGTH',
  'MEN_SHIRT_TOP_LENGTH',
];

const MEN_FORMAL_OUTERWEAR_TEMPLATE = [
  'MEN_NECK',
  'MEN_SHOULDER',
  'MEN_CHEST',
  'MEN_STOMACH_BELLY',
  'MEN_WAIST',
  'MEN_HIP',
  'MEN_ARM_HOLE',
  'MEN_WRIST',
  'MEN_SLEEVE_LENGTH',
  'MEN_JACKET_LENGTH',
];

const MEN_LOWER_BODY_TEMPLATE = [
  'MEN_WAIST',
  'MEN_HIP',
  'MEN_CROTCH_U_RISE',
  'MEN_TROUSER_LENGTH_OUTSEAM',
  'MEN_INSEAM',
  'MEN_THIGH',
  'MEN_KNEE_CIRCUMFERENCE',
  'MEN_CALF',
  'MEN_ANKLE_CIRCUMFERENCE',
  'MEN_HEIGHT',
];

const WOMEN_DRESS_TEMPLATE = [
  'WOMEN_SHOULDER_WIDTH',
  'WOMEN_FRONT_SHOULDER',
  'WOMEN_CHEST_FULL_BUST',
  'WOMEN_UNDERBUST',
  'WOMEN_WAIST',
  'WOMEN_HIP',
  'WOMEN_BUST_POINT_TO_BUST_POINT',
  'WOMEN_BUST_HEIGHT_APEX',
  'WOMEN_DRESS_TOP_LENGTH',
  'WOMEN_SKIRT_LENGTH',
];

const WOMEN_TOP_TEMPLATE = [
  'WOMEN_SHOULDER_WIDTH',
  'WOMEN_FRONT_SHOULDER',
  'WOMEN_CHEST_FULL_BUST',
  'WOMEN_UNDERBUST',
  'WOMEN_WAIST',
  'WOMEN_BUST_POINT_TO_BUST_POINT',
  'WOMEN_BUST_HEIGHT_APEX',
  'WOMEN_ARM_HOLE_CIRCUMFERENCE',
  'WOMEN_ARM_HOLE_DEPTH',
  'WOMEN_DRESS_TOP_LENGTH',
];

const WOMEN_LOWER_BODY_TEMPLATE = [
  'WOMEN_WAIST',
  'WOMEN_HIP',
  'WOMEN_WAIST_TO_HIP_LENGTH',
  'WOMEN_WAIST_TO_KNEE_LENGTH',
  'WOMEN_SKIRT_LENGTH',
];

const BASELINE_TEMPLATE_BY_GENDER: Record<'MEN' | 'WOMEN', string[]> = {
  MEN: [
    'MEN_HEIGHT',
    'MEN_SHOULDER',
    'MEN_CHEST',
    'MEN_WAIST',
    'MEN_HIP',
    'MEN_INSEAM',
    'MEN_SLEEVE_LENGTH',
  ],
  WOMEN: [
    'WOMEN_SHOULDER_WIDTH',
    'WOMEN_CHEST_FULL_BUST',
    'WOMEN_WAIST',
    'WOMEN_HIP',
    'WOMEN_BUST_POINT_TO_BUST_POINT',
    'WOMEN_DRESS_TOP_LENGTH',
    'WOMEN_SKIRT_LENGTH',
  ],
};

const CATEGORY_TEMPLATE_BY_SLUG = new Map<string, string[]>([
  ['agbada-kaftans', MEN_UPPER_BODY_TEMPLATE],
  ['shirts-tops-m', MEN_UPPER_BODY_TEMPLATE],
  ['suits-blazers', MEN_FORMAL_OUTERWEAR_TEMPLATE],
  ['trousers-chinos', MEN_LOWER_BODY_TEMPLATE],
  ['shorts-casual-m', MEN_LOWER_BODY_TEMPLATE],
  ['dresses-gowns', WOMEN_DRESS_TEMPLATE],
  ['jumpsuits-rompers', WOMEN_DRESS_TEMPLATE],
  ['plus-size-curvy', WOMEN_DRESS_TEMPLATE],
  ['tops-blouses', WOMEN_TOP_TEMPLATE],
  ['outerwear-w', WOMEN_TOP_TEMPLATE],
  ['skirts-wraps', WOMEN_LOWER_BODY_TEMPLATE],
  ['pants-trousers-w', WOMEN_LOWER_BODY_TEMPLATE],
]);

export const normalizeMeasurementKeyList = (
  keys: string[] | null | undefined,
) =>
  Array.from(
    new Set(
      (keys ?? [])
        .map((key) =>
          String(key ?? '')
            .trim()
            .toUpperCase(),
        )
        .filter(Boolean),
    ),
  );

export const normalizeIdList = (ids: string[] | null | undefined) =>
  Array.from(
    new Set((ids ?? []).map((id) => String(id ?? '').trim()).filter(Boolean)),
  );

export const resolveSourceMeasurementGender = (
  profile: SourceMeasurementContractProfile,
): 'MEN' | 'WOMEN' | null => {
  if (profile.customGender === 'MEN' || profile.customGender === 'WOMEN') {
    return profile.customGender;
  }

  if (profile.collectionType === CollectionType.MALE) {
    return 'MEN';
  }

  if (profile.collectionType === CollectionType.FEMALE) {
    return 'WOMEN';
  }

  return null;
};

export const measurementKeysContainOppositeGender = (
  keys: string[],
  sourceGender: 'MEN' | 'WOMEN',
) =>
  keys.some((key) =>
    sourceGender === 'MEN' ? key.startsWith('WOMEN_') : key.startsWith('MEN_'),
  );

export const resolveGarmentMeasurementTemplate = (
  profile: SourceMeasurementContractProfile,
  availableKeys?: string[],
) => {
  const categoryTypeSlug = String(profile.categoryTypeSlug ?? '')
    .trim()
    .toLowerCase();
  const gender = resolveSourceMeasurementGender(profile);
  const template =
    CATEGORY_TEMPLATE_BY_SLUG.get(categoryTypeSlug) ??
    (gender ? BASELINE_TEMPLATE_BY_GENDER[gender] : null);

  if (!template) {
    return [];
  }

  const normalizedTemplate = normalizeMeasurementKeyList(template);
  const normalizedAvailableKeys = normalizeMeasurementKeyList(availableKeys);

  if (normalizedAvailableKeys.length === 0) {
    return normalizedTemplate;
  }

  const availableKeySet = new Set(normalizedAvailableKeys);
  const filteredTemplate = normalizedTemplate.filter((key) =>
    availableKeySet.has(key),
  );

  return filteredTemplate.length > 0 ? filteredTemplate : normalizedTemplate;
};
