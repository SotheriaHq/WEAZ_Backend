import { ContentReviewReasonCode } from '@prisma/client';
import {
  buildSnapshot,
  evaluateRequiredChange,
  fingerprintSnapshot,
  REQUIRED_CHANGE_BY_REASON,
  summariseChanges,
} from './content-change-detection';

const REQUIRED = ['FRONT', 'BACK', 'LEFT_SIDE', 'RIGHT_SIDE'] as const;

const listing = (
  overrides: {
    title?: string;
    description?: string;
    audience?: string;
    media?: Array<{ fileUploadId: string; viewSlot: string }>;
  } = {},
) =>
  buildSnapshot({
    title: overrides.title ?? 'Adire Jacket',
    description: overrides.description ?? 'Hand-dyed indigo jacket.',
    audience: overrides.audience ?? 'MALE',
    media: overrides.media ?? [
      { fileUploadId: 'file-a', viewSlot: 'FRONT' },
      { fileUploadId: 'file-b', viewSlot: 'BACK' },
      { fileUploadId: 'file-c', viewSlot: 'LEFT_SIDE' },
      { fileUploadId: 'file-d', viewSlot: 'RIGHT_SIDE' },
    ],
    requiredSlots: REQUIRED,
  });

const verdict = (
  reasonCode: ContentReviewReasonCode,
  before: ReturnType<typeof listing>,
  after: ReturnType<typeof listing>,
) =>
  evaluateRequiredChange({
    requirement: REQUIRED_CHANGE_BY_REASON[reasonCode],
    before,
    after,
    requiredSlotCount: REQUIRED.length,
  });

describe('content change detection', () => {
  describe('fingerprint', () => {
    it('is stable for identical content', () => {
      expect(fingerprintSnapshot(listing())).toBe(
        fingerprintSnapshot(listing()),
      );
    });

    it('ignores whitespace-only edits, so padding the title is not a change', () => {
      const padded = listing({ title: '  Adire   Jacket  ' });
      expect(fingerprintSnapshot(padded)).toBe(fingerprintSnapshot(listing()));
    });

    it('changes when an image is replaced', () => {
      const replaced = listing({
        media: [
          { fileUploadId: 'file-NEW', viewSlot: 'FRONT' },
          { fileUploadId: 'file-b', viewSlot: 'BACK' },
          { fileUploadId: 'file-c', viewSlot: 'LEFT_SIDE' },
          { fileUploadId: 'file-d', viewSlot: 'RIGHT_SIDE' },
        ],
      });
      expect(fingerprintSnapshot(replaced)).not.toBe(
        fingerprintSnapshot(listing()),
      );
    });
  });

  describe('the reviewer asked about the images', () => {
    it('rejects a resubmission with the same photos', () => {
      const result = verdict(
        ContentReviewReasonCode.POOR_IMAGE_QUALITY,
        listing(),
        listing(),
      );
      expect(result.satisfied).toBe(false);
      expect(result.message).toMatch(/Replace at least one image/);
    });

    it('rejects retyping the description instead of fixing the photos', () => {
      const result = verdict(
        ContentReviewReasonCode.POOR_IMAGE_QUALITY,
        listing(),
        listing({ description: 'A completely different description.' }),
      );
      expect(result.satisfied).toBe(false);
    });

    it('rejects merely reordering the same photos', () => {
      const reordered = listing({
        media: [
          { fileUploadId: 'file-b', viewSlot: 'FRONT' },
          { fileUploadId: 'file-a', viewSlot: 'BACK' },
          { fileUploadId: 'file-c', viewSlot: 'LEFT_SIDE' },
          { fileUploadId: 'file-d', viewSlot: 'RIGHT_SIDE' },
        ],
      });
      expect(
        verdict(ContentReviewReasonCode.POOR_IMAGE_QUALITY, listing(), reordered)
          .satisfied,
      ).toBe(false);
    });

    it('accepts one replaced image', () => {
      const replaced = listing({
        media: [
          { fileUploadId: 'file-NEW', viewSlot: 'FRONT' },
          { fileUploadId: 'file-b', viewSlot: 'BACK' },
          { fileUploadId: 'file-c', viewSlot: 'LEFT_SIDE' },
          { fileUploadId: 'file-d', viewSlot: 'RIGHT_SIDE' },
        ],
      });
      expect(
        verdict(ContentReviewReasonCode.POOR_IMAGE_QUALITY, listing(), replaced)
          .satisfied,
      ).toBe(true);
    });
  });

  describe('the reviewer asked for a missing view', () => {
    const missingBack = listing({
      media: [
        { fileUploadId: 'file-a', viewSlot: 'FRONT' },
        { fileUploadId: 'file-c', viewSlot: 'LEFT_SIDE' },
        { fileUploadId: 'file-d', viewSlot: 'RIGHT_SIDE' },
      ],
    });

    it('rejects while the view is still missing, even if other edits were made', () => {
      const stillMissing = listing({
        title: 'Adire Jacket v2',
        media: [
          { fileUploadId: 'file-a', viewSlot: 'FRONT' },
          { fileUploadId: 'file-c', viewSlot: 'LEFT_SIDE' },
          { fileUploadId: 'file-d', viewSlot: 'RIGHT_SIDE' },
        ],
      });
      const result = verdict(
        ContentReviewReasonCode.MISSING_REQUIRED_VIEW,
        missingBack,
        stillMissing,
      );
      expect(result.satisfied).toBe(false);
      expect(result.message).toMatch(/missing required views/i);
    });

    it('accepts once all four required views are present', () => {
      expect(
        verdict(
          ContentReviewReasonCode.MISSING_REQUIRED_VIEW,
          missingBack,
          listing(),
        ).satisfied,
      ).toBe(true);
    });
  });

  describe('the reviewer asked about the wording or the filing', () => {
    it('rejects a new photo when the complaint was a false claim', () => {
      const newPhoto = listing({
        media: [
          { fileUploadId: 'file-NEW', viewSlot: 'FRONT' },
          { fileUploadId: 'file-b', viewSlot: 'BACK' },
          { fileUploadId: 'file-c', viewSlot: 'LEFT_SIDE' },
          { fileUploadId: 'file-d', viewSlot: 'RIGHT_SIDE' },
        ],
      });
      expect(
        verdict(
          ContentReviewReasonCode.UNSAFE_OR_FALSE_CLAIM,
          listing(),
          newPhoto,
        ).satisfied,
      ).toBe(false);
    });

    it('accepts an audience correction for a metadata mismatch', () => {
      expect(
        verdict(
          ContentReviewReasonCode.WRONG_CATEGORY_OR_METADATA_MISMATCH,
          listing(),
          listing({ audience: 'FEMALE' }),
        ).satisfied,
      ).toBe(true);
    });

    it('does not accept an audience change for a false-claim request', () => {
      expect(
        verdict(
          ContentReviewReasonCode.UNSAFE_OR_FALSE_CLAIM,
          listing(),
          listing({ audience: 'FEMALE' }),
        ).satisfied,
      ).toBe(false);
    });
  });

  describe('OTHER — a free-text request we cannot read', () => {
    it('still blocks a byte-identical resubmission', () => {
      const result = verdict(ContentReviewReasonCode.OTHER, listing(), listing());
      expect(result.satisfied).toBe(false);
      expect(result.message).toMatch(/Nothing has changed/);
    });

    it('accepts any visible edit', () => {
      expect(
        verdict(
          ContentReviewReasonCode.OTHER,
          listing(),
          listing({ title: 'Adire Jacket II' }),
        ).satisfied,
      ).toBe(true);
    });
  });

  describe('every reason code has a requirement', () => {
    it.each(Object.values(ContentReviewReasonCode))(
      '%s maps to a requirement',
      (code) => {
        expect(REQUIRED_CHANGE_BY_REASON[code]).toBeDefined();
      },
    );
  });

  describe('change summary', () => {
    it('is empty with no previous submission', () => {
      expect(summariseChanges(null, listing())).toEqual([]);
    });

    it('names a replaced image', () => {
      const replaced = listing({
        media: [
          { fileUploadId: 'file-NEW', viewSlot: 'FRONT' },
          { fileUploadId: 'file-b', viewSlot: 'BACK' },
          { fileUploadId: 'file-c', viewSlot: 'LEFT_SIDE' },
          { fileUploadId: 'file-d', viewSlot: 'RIGHT_SIDE' },
        ],
      });
      expect(summariseChanges(listing(), replaced)).toContain(
        '1 image(s) replaced',
      );
    });

    it('reports a reorder as a reorder, not as new images', () => {
      const reordered = listing({
        media: [
          { fileUploadId: 'file-b', viewSlot: 'FRONT' },
          { fileUploadId: 'file-a', viewSlot: 'BACK' },
          { fileUploadId: 'file-c', viewSlot: 'LEFT_SIDE' },
          { fileUploadId: 'file-d', viewSlot: 'RIGHT_SIDE' },
        ],
      });
      expect(summariseChanges(listing(), reordered)).toEqual([
        'Images reordered or reslotted',
      ]);
    });

    it('names added required views', () => {
      const missingBack = listing({
        media: [
          { fileUploadId: 'file-a', viewSlot: 'FRONT' },
          { fileUploadId: 'file-c', viewSlot: 'LEFT_SIDE' },
          { fileUploadId: 'file-d', viewSlot: 'RIGHT_SIDE' },
        ],
      });
      const summary = summariseChanges(missingBack, listing());
      expect(summary).toContain('Required view(s) added: BACK');
    });

    it('names title, description and audience edits together', () => {
      const edited = listing({
        title: 'New title',
        description: 'New description',
        audience: 'EVERYBODY',
      });
      expect(summariseChanges(listing(), edited)).toEqual([
        'Title edited',
        'Description edited',
        'Audience changed to EVERYBODY',
      ]);
    });
  });
});
