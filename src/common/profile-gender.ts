/**
 * Shopper gender — one source of truth.
 *
 * `UserProfile.gender` is the only place a person's gender is stored. Product
 * `Gender` (MEN/WOMEN/UNISEX) and collection `CollectionType`
 * (MALE/FEMALE/EVERYBODY) are audience labels on CONTENT, not identity. Every
 * caller that needs "what body is this shopper" or "what feed audience should
 * we prefer" must go through this module rather than inferring from
 * measurement-key prefixes or defaulting to WOMEN.
 */

export const PROFILE_GENDERS = [
  'MALE',
  'FEMALE',
  'NON_BINARY',
  'UNSPECIFIED',
] as const;

export type ProfileGender = (typeof PROFILE_GENDERS)[number];

/**
 * Shopper-facing labels. People identify as a man or a woman — never as
 * "men"/"women" (those are garment-audience words) and not as the stored
 * codes MALE/FEMALE.
 */
export const PROFILE_GENDER_OPTIONS: ReadonlyArray<{
  value: ProfileGender;
  label: string;
}> = [
  { value: 'MALE', label: 'Man' },
  { value: 'FEMALE', label: 'Woman' },
  { value: 'NON_BINARY', label: 'Non-binary' },
  { value: 'UNSPECIFIED', label: "I'd rather not say" },
];

export const PROFILE_GENDER_PROMPT = {
  title: 'How should we size clothes for you?',
  body: 'This helps WIEZ estimate your size and show clothes that fit how you shop. You can change it later in settings.',
  question: 'Are you a…',
} as const;

export function profileGenderLabel(
  gender: ProfileGender | null | undefined,
): string | null {
  if (!gender) return null;
  return PROFILE_GENDER_OPTIONS.find((option) => option.value === gender)?.label ?? null;
}

/** Body the size engine designates against. */
export type SizingBody = 'MEN' | 'WOMEN' | 'UNISEX';

/** Content audience on Collection / Product. */
export type FeedAudience = 'MALE' | 'FEMALE' | 'EVERYBODY';

export function isProfileGender(value: unknown): value is ProfileGender {
  return (
    typeof value === 'string' &&
    (PROFILE_GENDERS as readonly string[]).includes(value)
  );
}

export function parseProfileGender(value: unknown): ProfileGender | null {
  if (value == null) return null;
  const normalized = String(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (normalized === 'MALE' || normalized === 'MAN' || normalized === 'MEN') {
    return 'MALE';
  }
  if (
    normalized === 'FEMALE' ||
    normalized === 'WOMAN' ||
    normalized === 'WOMEN'
  ) {
    return 'FEMALE';
  }
  if (
    normalized === 'NON_BINARY' ||
    normalized === 'NONBINARY' ||
    normalized === 'NB'
  ) {
    return 'NON_BINARY';
  }
  if (
    normalized === 'UNSPECIFIED' ||
    normalized === 'PREFER_NOT_TO_SAY' ||
    normalized === 'RATHER_NOT_SAY' ||
    normalized === 'UNDISCLOSED'
  ) {
    return 'UNSPECIFIED';
  }
  return null;
}

/**
 * ISO 8559-2 / EN 13402 letter codes are published separately for men (chest)
 * and women (bust). Unisex / undisclosed uses the unisex alpha table — never
 * a silent default to WOMEN, which is how a men's chest was being read against
 * a women's bust ladder.
 */
export function sizingBodyFromProfileGender(
  gender: ProfileGender | null | undefined,
): SizingBody {
  if (gender === 'MALE') return 'MEN';
  if (gender === 'FEMALE') return 'WOMEN';
  return 'UNISEX';
}

/**
 * Feed ranking may PREFER matching audience plus EVERYBODY. It must not hide
 * EVERYBODY content, and it must not filter at all when the shopper has not
 * told us or chose not to say — that would quietly shrink the runway.
 */
export function feedAudienceFromProfileGender(
  gender: ProfileGender | null | undefined,
): FeedAudience[] {
  if (gender === 'MALE') return ['MALE', 'EVERYBODY'];
  if (gender === 'FEMALE') return ['FEMALE', 'EVERYBODY'];
  return ['MALE', 'FEMALE', 'EVERYBODY'];
}

/** Null means we have never asked. UNSPECIFIED is an answer. */
export function needsGenderPrompt(
  gender: ProfileGender | null | undefined,
): boolean {
  return gender == null;
}
