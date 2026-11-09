import { wiezGreeting, quotedTitle } from 'src/notifications/wiez-voice';

/**
 * Every word a brand reads about a content review: the inbox message and the
 * short push body, for each review event.
 *
 * The owner's rules (Nov 2026):
 *  - submitted: "<title> sent for review" — no mention of admins;
 *  - changes requested: greet with "Wiez <brand> 👋", say what happened, point
 *    at the fix — the notes live in the inbox and on the edit screen;
 *  - approved: "<title> has been approved and published on the Runway"
 *    (designs) or "…on the Market" (products).
 * Push bodies stay short enough for two lock-screen lines; inbox messages
 * carry the reviewer's feedback in full.
 */

export type ContentReviewCopyInput = {
  title?: string | null;
  entityType?: string | null;
  recipientName?: string | null;
  isPrivate?: boolean | null;
  /** Canned reason label (e.g. "Poor image quality"). */
  reasonLabel?: string | null;
  /** The reviewer's own note. */
  reasonNote?: string | null;
  /** Human time of the event, e.g. "9 Nov, 14:05". */
  when?: string | null;
};

export function contentEntityLabel(entityType?: string | null): 'product' | 'design' {
  return String(entityType ?? '').toUpperCase().includes('PRODUCT') ? 'product' : 'design';
}

/** Where an approved piece appears: products in the Market, designs on the Runway. */
export function contentSurface(entityType?: string | null): 'Market' | 'Runway' {
  return contentEntityLabel(entityType) === 'product' ? 'Market' : 'Runway';
}

function trimSentence(value?: string | null): string | null {
  const clean = typeof value === 'string' ? value.trim().replace(/[.!\s]+$/u, '') : '';
  return clean || null;
}

/** "Poor image quality — the front view is blurry", either part optional. */
export function reviewFeedback(
  input: Pick<ContentReviewCopyInput, 'reasonLabel' | 'reasonNote'>,
): string | null {
  const parts = [trimSentence(input.reasonLabel), trimSentence(input.reasonNote)].filter(Boolean);
  return parts.length ? parts.join(' — ') : null;
}

function subject(input: ContentReviewCopyInput, start: boolean): string {
  const quoted = quotedTitle(input.title);
  if (quoted) return quoted;
  const label = contentEntityLabel(input.entityType);
  return start ? `Your ${label}` : `your ${label}`;
}

/** The short push body (two lock-screen lines). */
export function contentReviewPushBody(event: string, input: ContentReviewCopyInput): string {
  const subjectStart = subject(input, true);
  const subjectMid = subject(input, false);
  const surface = contentSurface(input.entityType);
  switch (event) {
    case 'CONTENT_SUBMITTED_FOR_REVIEW':
      return `${subjectStart} sent for review. We’ll let you know the moment it’s live.`;
    case 'CONTENT_RESUBMITTED':
      return `${subjectStart} is back in review. We’ll let you know soon.`;
    case 'CONTENT_CHANGES_REQUESTED':
      return `${wiezGreeting(input.recipientName)} A few changes were requested on ${subjectMid}. Tap to see what to update.`;
    case 'CONTENT_REVIEW_APPROVED':
      return input.isPrivate
        ? `${subjectStart} has been approved. It’s set to Private — make it Public when you’re ready.`
        : `${subjectStart} has been approved and published on the ${surface} 🎉`;
    case 'CONTENT_PUBLISHED':
      return `${subjectStart} is live on the ${surface} 🎉`;
    case 'CONTENT_REVIEW_REJECTED':
      return `${wiezGreeting(input.recipientName)} ${subjectStart} wasn’t approved this time. Tap to see why and resubmit.`;
    case 'CONTENT_REVIEW_FAILED':
      return `We couldn’t finish checking ${subjectMid}. Tap to try again.`;
    case 'CONTENT_PUBLISH_FAILED':
      return `We couldn’t publish ${subjectMid}. Tap to try again.`;
    default:
      return `There’s an update on ${subjectMid}. Tap to see it.`;
  }
}

/** The inbox message: the push line plus the detail the brand needs to act. */
export function contentReviewInboxMessage(event: string, input: ContentReviewCopyInput): string {
  const subjectStart = subject(input, true);
  const subjectMid = subject(input, false);
  const surface = contentSurface(input.entityType);
  const at = input.when ? ` (${input.when})` : '';
  const feedback = reviewFeedback(input);
  switch (event) {
    case 'CONTENT_SUBMITTED_FOR_REVIEW':
      return `${subjectStart} sent for review${at}. We’ll let you know the moment it’s live.`;
    case 'CONTENT_RESUBMITTED':
      return `${subjectStart} is back in review${at}. We’ll let you know soon.`;
    case 'CONTENT_CHANGES_REQUESTED':
      return (
        `${wiezGreeting(input.recipientName)} A few changes were requested on ${subjectMid}${at}.` +
        (feedback ? ` What to update: ${feedback}.` : '') +
        ' Make the changes, then resubmit for review.'
      );
    case 'CONTENT_REVIEW_APPROVED':
      return input.isPrivate
        ? `${subjectStart} has been approved${at}. It’s set to Private, so it stays off the ${surface} — make it Public when you’re ready.`
        : `${subjectStart} has been approved and published on the ${surface}${at} 🎉 Share it with your customers to get more eyes on it.`;
    case 'CONTENT_PUBLISHED':
      return `${subjectStart} is live on the ${surface}${at} 🎉`;
    case 'CONTENT_REVIEW_REJECTED':
      return (
        `${wiezGreeting(input.recipientName)} ${subjectStart} wasn’t approved this time${at}.` +
        (feedback ? ` Why: ${feedback}.` : '') +
        ' Update it and resubmit when you’re ready.'
      );
    case 'CONTENT_REVIEW_FAILED':
      return `We couldn’t finish checking ${subjectMid}${at}. Open it and submit again.`;
    case 'CONTENT_PUBLISH_FAILED':
      return `We couldn’t publish ${subjectMid}${at}. Open it and try again.`;
    default:
      return `There’s an update on ${subjectMid}${at}.`;
  }
}
