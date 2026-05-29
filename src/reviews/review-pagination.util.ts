import { ReviewSortOption } from './dto';

type ReviewCursorPayload = {
  sort: ReviewSortOption;
  id: string;
  createdAt: string;
  rating?: number;
  helpfulCount?: number;
};

type CreatedAtCursorPayload = {
  id: string;
  createdAt: string;
};

type ReviewCursorReview = {
  id: string;
  createdAt: Date;
  rating: number;
  helpfulCount: number;
};

const normalizeReviewSort = (sort?: ReviewSortOption): ReviewSortOption =>
  sort ?? ReviewSortOption.NEWEST;

const encodeCursor = (payload: object): string =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

const decodeCursor = <T>(cursor?: string): T | null => {
  if (!cursor || !cursor.trim()) {
    return null;
  }

  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    return JSON.parse(decoded) as T;
  } catch {
    return null;
  }
};

const parseDate = (value: string): Date | null => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const isValidNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const buildReviewCursor = (
  sort: ReviewSortOption | undefined,
  review: ReviewCursorReview,
): string => {
  const normalizedSort = normalizeReviewSort(sort);
  const payload: ReviewCursorPayload = {
    sort: normalizedSort,
    id: review.id,
    createdAt: review.createdAt.toISOString(),
  };

  if (
    normalizedSort === ReviewSortOption.HIGHEST_RATING ||
    normalizedSort === ReviewSortOption.LOWEST_RATING
  ) {
    payload.rating = review.rating;
  }

  if (normalizedSort === ReviewSortOption.MOST_HELPFUL) {
    payload.helpfulCount = review.helpfulCount;
  }

  return encodeCursor(payload);
};

export const buildCreatedAtCursor = (item: {
  id: string;
  createdAt: Date;
}): string =>
  encodeCursor({
    id: item.id,
    createdAt: item.createdAt.toISOString(),
  } satisfies CreatedAtCursorPayload);

export const buildCreatedAtCursorWhere = (
  cursor?: string,
): Record<string, unknown> | null => {
  const payload = decodeCursor<CreatedAtCursorPayload>(cursor);
  if (
    !payload ||
    typeof payload.id !== 'string' ||
    typeof payload.createdAt !== 'string'
  ) {
    return null;
  }

  const createdAt = parseDate(payload.createdAt);
  if (!createdAt) {
    return null;
  }

  return {
    OR: [
      { createdAt: { lt: createdAt } },
      { createdAt, id: { lt: payload.id } },
    ],
  };
};

export const buildReviewCursorWhere = (
  sort: ReviewSortOption | undefined,
  cursor?: string,
): Record<string, unknown> | null => {
  const normalizedSort = normalizeReviewSort(sort);
  const payload = decodeCursor<ReviewCursorPayload>(cursor);

  if (
    !payload ||
    payload.sort !== normalizedSort ||
    typeof payload.id !== 'string' ||
    typeof payload.createdAt !== 'string'
  ) {
    return null;
  }

  const createdAt = parseDate(payload.createdAt);
  if (!createdAt) {
    return null;
  }

  switch (normalizedSort) {
    case ReviewSortOption.HIGHEST_RATING:
      if (!isValidNumber(payload.rating)) {
        return null;
      }

      return {
        OR: [
          { rating: { lt: payload.rating } },
          { rating: payload.rating, createdAt: { lt: createdAt } },
          { rating: payload.rating, createdAt, id: { lt: payload.id } },
        ],
      };

    case ReviewSortOption.LOWEST_RATING:
      if (!isValidNumber(payload.rating)) {
        return null;
      }

      return {
        OR: [
          { rating: { gt: payload.rating } },
          { rating: payload.rating, createdAt: { lt: createdAt } },
          { rating: payload.rating, createdAt, id: { lt: payload.id } },
        ],
      };

    case ReviewSortOption.MOST_HELPFUL:
      if (!isValidNumber(payload.helpfulCount)) {
        return null;
      }

      return {
        OR: [
          { helpfulCount: { lt: payload.helpfulCount } },
          {
            helpfulCount: payload.helpfulCount,
            createdAt: { lt: createdAt },
          },
          {
            helpfulCount: payload.helpfulCount,
            createdAt,
            id: { lt: payload.id },
          },
        ],
      };

    case ReviewSortOption.NEWEST:
    default:
      return buildCreatedAtCursorWhere(cursor);
  }
};
