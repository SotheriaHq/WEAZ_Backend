/**
 * "Wiez" is how WIEZ says hello (Rule 40).
 *
 * Wherever a greeting fits — a notification, an email opening, an empty
 * state — it reads "Wiez <name> 👋" rather than "Hi <name>" or "Hello".
 * One helper so the spelling, spacing and wave stay identical everywhere.
 * Good news (documents approved, verified) swaps the wave for 🎉.
 */
export function wiezGreeting(
  name?: string | null,
  mark: '👋' | '🎉' = '👋',
): string {
  const clean = typeof name === 'string' ? name.trim() : '';
  return clean ? `Wiez ${clean} ${mark}` : `Wiez ${mark}`;
}

/** A content title as it appears inside copy: curly-quoted, trimmed. */
export function quotedTitle(title?: string | null): string | null {
  const clean = typeof title === 'string' ? title.trim() : '';
  return clean ? `“${clean}”` : null;
}
