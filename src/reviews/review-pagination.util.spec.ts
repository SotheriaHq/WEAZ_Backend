import 'reflect-metadata';

import {
  buildCreatedAtCursor,
  buildCreatedAtCursorWhere,
  buildReviewCursor,
  buildReviewCursorWhere,
} from './review-pagination.util';
import { ReviewSortOption } from './dto';

describe('review pagination utilities', () => {
  const createdAt = new Date('2026-03-10T10:00:00.000Z');

  it('builds a composite newest cursor filter using createdAt and id', () => {
    const cursor = buildReviewCursor(ReviewSortOption.NEWEST, {
      id: 'review-2',
      createdAt,
      rating: 4,
      helpfulCount: 10,
    });

    expect(buildReviewCursorWhere(ReviewSortOption.NEWEST, cursor)).toEqual({
      OR: [
        { createdAt: { lt: createdAt } },
        { createdAt, id: { lt: 'review-2' } },
      ],
    });
  });

  it('builds a composite most-helpful cursor filter using helpfulCount, createdAt, and id', () => {
    const cursor = buildReviewCursor(ReviewSortOption.MOST_HELPFUL, {
      id: 'review-5',
      createdAt,
      rating: 5,
      helpfulCount: 12,
    });

    expect(
      buildReviewCursorWhere(ReviewSortOption.MOST_HELPFUL, cursor),
    ).toEqual({
      OR: [
        { helpfulCount: { lt: 12 } },
        { helpfulCount: 12, createdAt: { lt: createdAt } },
        { helpfulCount: 12, createdAt, id: { lt: 'review-5' } },
      ],
    });
  });

  it('returns null for invalid cursor payloads', () => {
    expect(
      buildReviewCursorWhere(ReviewSortOption.NEWEST, 'not-a-valid-cursor'),
    ).toBeNull();
    expect(buildCreatedAtCursorWhere('not-a-valid-cursor')).toBeNull();
  });

  it('builds createdAt cursors for admin feeds', () => {
    const cursor = buildCreatedAtCursor({
      id: 'report-2',
      createdAt,
    });

    expect(buildCreatedAtCursorWhere(cursor)).toEqual({
      OR: [
        { createdAt: { lt: createdAt } },
        { createdAt, id: { lt: 'report-2' } },
      ],
    });
  });
});
