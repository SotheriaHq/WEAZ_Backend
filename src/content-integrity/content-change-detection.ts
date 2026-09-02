import { createHash } from 'crypto';
import { ContentReviewReasonCode } from '@prisma/client';

/**
 * Change detection for the review queue.
 *
 * A reviewer asks a brand to fix something. Until now nothing checked that the
 * brand fixed anything — republishing an untouched item put it straight back in
 * the queue as new work, and the reviewer had no way to tell.
 *
 * The rule this module enforces: while a change request is open, a resubmission
 * must actually change the thing that was asked about.
 *
 * Everything here is a pure function of two snapshots so it can be tested
 * without a database, and so the same comparison drives both the gate (did they
 * change it?) and the reviewer's summary (what did they change?).
 */

/**
 * What the reviewer can actually see, and nothing else.
 *
 * That boundary is deliberate and is what makes the rule explainable to a
 * brand: if the review drawer shows it, it is in the snapshot; if it does not —
 * internal timestamps, draft versions, view counts — it is not, and touching it
 * cannot be used to slip past the gate.
 */
export type ReviewableSnapshot = {
  title: string;
  description: string;
  /** MALE | FEMALE | EVERYBODY. Reviewed as metadata correctness. */
  audience: string;
  /** Ordered `slot:fileUploadId`. Order matters — the reviewer sees a sequence. */
  mediaOrder: string[];
  /** Sorted unique fileUploadIds. Order-independent, so a reshuffle is not a "new image". */
  mediaIds: string[];
  /** Sorted required slots that are present. */
  filledRequiredSlots: string[];
};

export type ChangeRequirement =
  | 'MEDIA_REPLACED'
  | 'REQUIRED_SLOTS_FILLED'
  | 'TEXT_EDITED'
  | 'METADATA_EDITED'
  | 'ANYTHING';

/**
 * Each reason code names what the reviewer objected to, so each one implies a
 * specific, checkable repair. Where a code implies nothing specific it falls
 * back to ANYTHING, which still blocks a byte-identical resubmission.
 */
export const REQUIRED_CHANGE_BY_REASON: Record<
  ContentReviewReasonCode,
  ChangeRequirement
> = {
  // The complaint is about the images themselves, so a different image is the
  // only thing that can answer it. Reordering the same photos cannot.
  [ContentReviewReasonCode.POOR_IMAGE_QUALITY]: 'MEDIA_REPLACED',
  [ContentReviewReasonCode.DUPLICATE_ANGLE]: 'MEDIA_REPLACED',
  [ContentReviewReasonCode.MODEL_FABRIC_MISMATCH]: 'MEDIA_REPLACED',
  [ContentReviewReasonCode.AI_OR_MANIPULATED_IMAGE_SUSPECTED]: 'MEDIA_REPLACED',
  [ContentReviewReasonCode.PROHIBITED_CONTENT]: 'MEDIA_REPLACED',
  [ContentReviewReasonCode.INTELLECTUAL_PROPERTY_OR_BRAND_MISUSE]:
    'MEDIA_REPLACED',

  // A named, countable requirement: the four required views must be present.
  [ContentReviewReasonCode.MISSING_REQUIRED_VIEW]: 'REQUIRED_SLOTS_FILLED',

  // The words are wrong.
  [ContentReviewReasonCode.UNSAFE_OR_FALSE_CLAIM]: 'TEXT_EDITED',
  [ContentReviewReasonCode.NOT_A_PRODUCT_OR_DESIGN_LISTING]: 'TEXT_EDITED',

  // Title, description or audience — the metadata the listing is filed under.
  [ContentReviewReasonCode.WRONG_CATEGORY_OR_METADATA_MISMATCH]:
    'METADATA_EDITED',

  // Free text. We cannot read the reviewer's note, so we can only insist that
  // something the reviewer can see is different.
  [ContentReviewReasonCode.OTHER]: 'ANYTHING',
};

const REQUIREMENT_MESSAGE: Record<ChangeRequirement, string> = {
  MEDIA_REPLACED:
    'Replace at least one image before resubmitting — reordering the same photos does not answer this request.',
  REQUIRED_SLOTS_FILLED:
    'Add the missing required views (Front, Back, Left Side, Right Side) before resubmitting.',
  TEXT_EDITED:
    'Edit the title or description before resubmitting — neither has changed since the reviewer asked.',
  METADATA_EDITED:
    'Edit the title, description or audience before resubmitting — none of them has changed since the reviewer asked.',
  ANYTHING:
    'Nothing has changed since the reviewer asked for changes. Make the requested edit before resubmitting.',
};

const normalizeText = (value: unknown): string =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

export function buildSnapshot(input: {
  title?: unknown;
  description?: unknown;
  audience?: unknown;
  /** Media in display order. */
  media: Array<{ fileUploadId?: string | null; viewSlot?: string | null }>;
  requiredSlots: readonly string[];
}): ReviewableSnapshot {
  const media = (input.media ?? []).filter((row) => row?.fileUploadId);
  const mediaOrder = media.map(
    (row) => `${row.viewSlot ?? 'UNSLOTTED'}:${row.fileUploadId}`,
  );
  const mediaIds = Array.from(
    new Set(media.map((row) => String(row.fileUploadId))),
  ).sort();
  const present = new Set(
    media.map((row) => String(row.viewSlot ?? '')).filter(Boolean),
  );
  return {
    title: normalizeText(input.title),
    description: normalizeText(input.description),
    audience: String(input.audience ?? '').toUpperCase(),
    mediaOrder,
    mediaIds,
    filledRequiredSlots: input.requiredSlots
      .filter((slot) => present.has(slot))
      .sort(),
  };
}

/**
 * Stable hash of everything the reviewer sees. Key order is fixed by the
 * literal below rather than by `Object.keys`, so the same content always
 * produces the same digest across processes and Node versions.
 */
export function fingerprintSnapshot(snapshot: ReviewableSnapshot): string {
  const canonical = JSON.stringify([
    snapshot.title,
    snapshot.description,
    snapshot.audience,
    snapshot.mediaOrder,
    snapshot.mediaIds,
    snapshot.filledRequiredSlots,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Did the resubmission do what was asked?
 *
 * `requiredSlotCount` is how many slots must be filled for
 * REQUIRED_SLOTS_FILLED to pass — passed in rather than imported so this module
 * stays free of the constants file and remains trivially testable.
 */
export function evaluateRequiredChange(args: {
  requirement: ChangeRequirement;
  before: ReviewableSnapshot;
  after: ReviewableSnapshot;
  requiredSlotCount: number;
}): { satisfied: boolean; message: string } {
  const { requirement, before, after } = args;

  const textEdited =
    before.title !== after.title || before.description !== after.description;
  const metadataEdited = textEdited || before.audience !== after.audience;
  const mediaReplaced = !sameSet(before.mediaIds, after.mediaIds);
  const anythingChanged =
    fingerprintSnapshot(before) !== fingerprintSnapshot(after);

  let satisfied: boolean;
  switch (requirement) {
    case 'MEDIA_REPLACED':
      satisfied = mediaReplaced;
      break;
    case 'REQUIRED_SLOTS_FILLED':
      satisfied = after.filledRequiredSlots.length >= args.requiredSlotCount;
      break;
    case 'TEXT_EDITED':
      satisfied = textEdited;
      break;
    case 'METADATA_EDITED':
      satisfied = metadataEdited;
      break;
    case 'ANYTHING':
    default:
      satisfied = anythingChanged;
      break;
  }

  return { satisfied, message: satisfied ? '' : REQUIREMENT_MESSAGE[requirement] };
}

/**
 * Plain-language list of what changed, stored on the new submission so the
 * reviewer sees it without a second query and without re-deriving history.
 */
export function summariseChanges(
  before: ReviewableSnapshot | null,
  after: ReviewableSnapshot,
): string[] {
  if (!before) return [];
  const changes: string[] = [];

  if (before.title !== after.title) changes.push('Title edited');
  if (before.description !== after.description) changes.push('Description edited');
  if (before.audience !== after.audience) {
    changes.push(`Audience changed to ${after.audience || 'unset'}`);
  }

  const beforeIds = new Set(before.mediaIds);
  const afterIds = new Set(after.mediaIds);
  const added = after.mediaIds.filter((id) => !beforeIds.has(id)).length;
  const removed = before.mediaIds.filter((id) => !afterIds.has(id)).length;

  if (added && removed) {
    changes.push(`${Math.min(added, removed)} image(s) replaced`);
    if (added > removed) changes.push(`${added - removed} image(s) added`);
    if (removed > added) changes.push(`${removed - added} image(s) removed`);
  } else if (added) {
    changes.push(`${added} image(s) added`);
  } else if (removed) {
    changes.push(`${removed} image(s) removed`);
  } else if (!sameSet(before.mediaOrder, after.mediaOrder)) {
    // Same files, different slots or sequence. Worth saying, because on its own
    // it does NOT answer an image-quality request.
    changes.push('Images reordered or reslotted');
  }

  const newSlots = after.filledRequiredSlots.filter(
    (slot) => !before.filledRequiredSlots.includes(slot),
  );
  if (newSlots.length) {
    changes.push(`Required view(s) added: ${newSlots.join(', ')}`);
  }

  return changes;
}
