/**
 * PHASE 2: Shared tag validation utilities
 * Used by both frontend and backend to ensure consistent tag handling
 */

export const TAG_CONFIG = {
  MIN_LENGTH: 2,
  MAX_LENGTH: 24,
  MAX_TAGS_PER_COLLECTION: 10,
  // Regex: lowercase letters, numbers, dash, underscore, dot only
  REGEX: /^[a-z0-9._-]+$/,
} as const;

/**
 * Normalize a tag to lowercase, trim whitespace, and remove invalid characters
 */
export function normalizeTag(input: string): string {
  if (typeof input !== 'string') return '';

  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-') // Replace spaces with dashes
    .replace(/[^a-z0-9._-]/g, '') // Remove invalid characters
    .slice(0, TAG_CONFIG.MAX_LENGTH);
}

/**
 * Validate a single tag
 * Returns { valid: true } or { valid: false, error: string }
 */
export function validateTag(input: string): { valid: boolean; error?: string } {
  if (typeof input !== 'string') {
    return { valid: false, error: 'Tag must be a string' };
  }

  const normalized = normalizeTag(input);

  if (normalized.length < TAG_CONFIG.MIN_LENGTH) {
    return {
      valid: false,
      error: `Tag must be at least ${TAG_CONFIG.MIN_LENGTH} characters`,
    };
  }

  if (normalized.length > TAG_CONFIG.MAX_LENGTH) {
    return {
      valid: false,
      error: `Tag must be at most ${TAG_CONFIG.MAX_LENGTH} characters`,
    };
  }

  if (!TAG_CONFIG.REGEX.test(normalized)) {
    return {
      valid: false,
      error:
        'Tag can only contain lowercase letters, numbers, dashes, underscores, and dots',
    };
  }

  return { valid: true };
}

/**
 * Sanitize an array of tags:
 * - Normalize each tag
 * - Remove invalid tags
 * - Remove duplicates (case-insensitive)
 * - Limit to max count
 */
export function sanitizeTags(
  tags: string[],
  maxCount: number = TAG_CONFIG.MAX_TAGS_PER_COLLECTION,
): string[] {
  if (!Array.isArray(tags)) return [];

  const normalized = tags
    .map((tag) => normalizeTag(tag))
    .filter((tag) => {
      if (!tag) return false;
      const validation = validateTag(tag);
      return validation.valid;
    });

  // Remove duplicates using Set (already normalized to lowercase)
  const unique = Array.from(new Set(normalized));

  return unique.slice(0, maxCount);
}

/**
 * Check if a tag already exists in a list (case-insensitive)
 */
export function tagExists(tag: string, existingTags: string[]): boolean {
  const normalized = normalizeTag(tag);
  const normalizedExisting = existingTags.map((t) => normalizeTag(t));
  return normalizedExisting.includes(normalized);
}
