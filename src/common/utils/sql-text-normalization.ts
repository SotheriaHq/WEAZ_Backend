import { Prisma } from '@prisma/client';

// ECMAScript WhiteSpace plus LineTerminator code points. PostgreSQL's default
// btrim removes only ASCII spaces. Compare the operations in PostgreSQL tests.
const TRIM_CHARACTERS =
  '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

/** Trimming only: URL content must never undergo Unicode compatibility folding. */
export function trimSql(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`btrim(${value},${TRIM_CHARACTERS})`;
}

/** NFKC then trimming, in the same order used by the filter boundary. */
export function normalizeTokenSql(value: Prisma.Sql): Prisma.Sql {
  return trimSql(Prisma.sql`normalize(${value},NFKC)`);
}
