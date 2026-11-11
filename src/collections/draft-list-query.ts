import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { validate as isUuid } from 'uuid';

export type DraftListOptions = { cursor?: string; limit?: string | number; domain?: 'DESIGN' | 'STORE' };
type DraftCursor = { v: 1; u: string; t: string; i: string };
// Match JavaScript trim(), preserving the existing published-title exclusion
// without loading every published title into application memory.
const trimWhitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

export function draftListPage(userId: string, options: DraftListOptions = {}) {
  const rawLimit = options.limit ?? 50;
  if ((typeof rawLimit !== 'number' && !/^[1-9]\d{0,2}$/.test(rawLimit)) ||
    !Number.isInteger(Number(rawLimit)) || Number(rawLimit) < 1 || Number(rawLimit) > 100)
    throw new BadRequestException('Draft page size must be between 1 and 100.');
  const limit = Number(rawLimit);
  let cursor: DraftCursor | undefined;
  if (options.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(options.cursor)) throw new Error();
      const value = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as DraftCursor;
      if (value.v !== 1 || value.u !== userId || !isUuid(value.i) || typeof value.t !== 'string' ||
        new Date(value.t).toISOString() !== value.t) throw new Error();
      cursor = value;
    } catch { throw new BadRequestException('Invalid draft-page cursor. Reload your draft list.'); }
  }
  return { limit, query: Prisma.sql`
    WITH page AS (
      SELECT draft."_id" AS id, draft."createdAt", draft."coverMediaId"
      FROM "Collection" draft
      WHERE draft."ownerId" = ${userId}::uuid AND draft.status = 'DRAFT' AND draft."deletedAt" IS NULL
        ${options.domain ? Prisma.sql`AND draft.domain = ${options.domain}::"CollectionDomain"` : Prisma.empty}
        ${cursor ? Prisma.sql`AND (draft."createdAt", draft."_id") < (${new Date(cursor.t)}, ${cursor.i}::uuid)` : Prisma.empty}
        AND NOT EXISTS (
          SELECT 1 FROM "Collection" published
          WHERE published."ownerId" = draft."ownerId" AND published.status = 'PUBLISHED' AND published."deletedAt" IS NULL
            AND btrim(published.title, ${trimWhitespace}) <> ''
            AND btrim(published.title, ${trimWhitespace}) = draft.title
        )
      ORDER BY draft."createdAt" DESC, draft."_id" DESC LIMIT ${limit + 1}
    )
    SELECT page.id, page."createdAt", cover."_id" AS "coverMediaId"
    FROM page LEFT JOIN LATERAL (
      SELECT media."_id" FROM "CollectionMedia" media WHERE media."collectionId" = page.id
      ORDER BY CASE WHEN media."_id" = page."coverMediaId" THEN 0 ELSE 1 END, media."orderIndex", media."_id"
      LIMIT 1
    ) cover ON true
    ORDER BY page."createdAt" DESC, page.id DESC
  ` };
}

export function draftListCursor(userId: string, row: { id: string; createdAt: Date }): string {
  return Buffer.from(JSON.stringify({ v: 1, u: userId, t: row.createdAt.toISOString(), i: row.id })).toString('base64url');
}
