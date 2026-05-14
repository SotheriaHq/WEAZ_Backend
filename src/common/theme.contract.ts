export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export type ResolvedTheme = 'light' | 'dark';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function normalizeThemePreference(
  value: unknown,
  fallback: ThemePreference = 'system',
): ThemePreference {
  return isThemePreference(value) ? value : fallback;
}
