import { createHash } from 'node:crypto';
import { TAG_CONFIG } from '../../common/utils/tag-validator';
import {
  SEARCH_LEXICON_SOURCE_PRIORITY,
  type SearchLexiconSourceRow,
} from './search-lexicon-source.sql';
import {
  formKey,
  lexiconTokens,
  normalizeLexiconText,
} from './search-lexicon.text';
import {
  SEARCH_LEXICON_KINDS,
  SEARCH_LEXICON_LIMITS,
  SEARCH_LEXICON_SCHEMA,
  type SearchLexiconBlob,
  type SearchLexiconEntry,
  type SearchLexiconKind,
  type SearchLexiconSynonym,
} from './search-lexicon.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CONTROL = /[\u0000-\u001f\u007f�]/u;
/** Category labels like "Senator Wear" are searched as "senator" too. */
const CATEGORY_SUFFIX =
  /\s+(?:wear|wears|set|sets|style|styles|clothing|outfit|outfits)$/;

export class SearchLexiconCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchLexiconCapacityError';
  }
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const result = value.normalize('NFKC').trim();
  if (!result || result.length > maxLength || CONTROL.test(result)) return null;
  return result;
}

function count(value: unknown): number {
  const result = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : 0;
}

function money(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 99_999_999.99)
    return null;
  return Math.round(result * 100) / 100;
}

function validValue(kind: SearchLexiconKind, value: string): boolean {
  switch (kind) {
    case 'category':
    case 'type':
    case 'brand':
      return UUID.test(value);
    case 'dimension':
      return SLUG.test(value);
    case 'tag':
      return (
        value.length >= TAG_CONFIG.MIN_LENGTH &&
        value.length <= TAG_CONFIG.MAX_LENGTH &&
        TAG_CONFIG.REGEX.test(value)
      );
    default:
      return value.length <= SEARCH_LEXICON_LIMITS.valueCharacters;
  }
}

function formsFor(kind: SearchLexiconKind, names: readonly string[]): string[] {
  const raw = new Set<string>();
  for (const name of names) {
    if (typeof name !== 'string') continue;
    raw.add(name);
    // "Owambe / Party" also answers to "owambe" and "party".
    if (kind === 'dimension' && name.includes('/'))
      for (const part of name.split('/')) raw.add(part);
    if (kind === 'category') {
      // "Dresses & Gowns" also answers to "dress" and "gown".
      for (const part of [name, ...name.split(/\s*[&/+]\s*|\s+and\s+/i)]) {
        raw.add(part);
        const stripped = normalizeLexiconText(part).replace(
          CATEGORY_SUFFIX,
          '',
        );
        if (stripped.length >= 3) raw.add(stripped);
      }
    }
    if (kind === 'tag') raw.add(name.replace(/[-_.]+/g, ' '));
  }
  const forms = new Set<string>();
  for (const value of raw) {
    const key = formKey(value);
    const tokens = lexiconTokens(key);
    if (
      tokens.length >= 1 &&
      tokens.length <= SEARCH_LEXICON_LIMITS.formTokens &&
      key.length <= SEARCH_LEXICON_LIMITS.formCharacters &&
      formKey(key) === key
    )
      forms.add(key);
  }
  return [...forms].sort().slice(0, SEARCH_LEXICON_LIMITS.formsPerEntry);
}

/** Canonical bytes; the version changes exactly when any served input changes. */
function digest(
  blob: Pick<SearchLexiconBlob, 'entries' | 'synonyms' | 'words' | 'price'>,
): string {
  return createHash('sha256')
    .update(SEARCH_LEXICON_SCHEMA + '\n')
    .update(JSON.stringify(blob))
    .digest('hex')
    .slice(0, 24);
}

/**
 * Maps one bounded source result. Mandatory vocabulary beyond the ceiling is a
 * refusal (the caller keeps the last good lexicon); only the optional
 * known-word list may be truncated to fit.
 */
export function buildSearchLexiconBlob(
  rows: readonly SearchLexiconSourceRow[],
  input: { sourceAsOf: Date; builtAt: Date; maxRows: number },
): SearchLexiconBlob {
  if (rows.length > input.maxRows) {
    const overflow = rows[input.maxRows];
    if (overflow.kind !== 'word')
      throw new SearchLexiconCapacityError(
        'Approved search vocabulary exceeds the lexicon row ceiling',
      );
  }
  const bounded = rows.slice(0, input.maxRows);
  let price: SearchLexiconBlob['price'] = null;
  const synonyms: SearchLexiconSynonym[] = [];
  const entries: SearchLexiconEntry[] = [];
  const words = new Set<string>();
  for (const row of bounded) {
    if (
      !Object.prototype.hasOwnProperty.call(
        SEARCH_LEXICON_SOURCE_PRIORITY,
        row.kind,
      )
    )
      throw new RangeError('Unexpected lexicon source row');
    if (row.kind === 'price') {
      const p30 = money(row.p30),
        p80 = money(row.p80),
        total = count(row.count);
      if (p30 !== null && p80 !== null && total > 0 && p30 <= p80)
        price = Object.freeze({ p30, p80, count: total });
      continue;
    }
    if (row.kind === 'synonym') {
      const term = formKey(row.value),
        canonical = formKey(row.label);
      if (isKey(term) && isKey(canonical) && term !== canonical)
        synonyms.push(Object.freeze({ term, canonical }));
      continue;
    }
    if (row.kind === 'word') {
      const word = normalizeLexiconText(row.value);
      if (word && !word.includes(' ') && word.length <= 32) words.add(word);
      continue;
    }
    const kind = row.kind as SearchLexiconKind;
    if (!SEARCH_LEXICON_KINDS.includes(kind)) continue;
    const value = text(row.value, SEARCH_LEXICON_LIMITS.valueCharacters);
    const total = count(row.count);
    if (!value || total < 1 || !validValue(kind, value)) continue;
    const dimension = kind === 'dimension' ? text(row.dimension, 80) : null;
    if (kind === 'dimension' && (!dimension || !SLUG.test(dimension))) continue;
    const categoryId = kind === 'type' ? text(row.categoryId, 36) : null;
    if (kind === 'type' && (!categoryId || !UUID.test(categoryId))) continue;
    const label = text(row.label, 160) ?? value;
    const forms =
      kind === 'size'
        ? [normalizeLexiconText(value)].filter(Boolean)
        : formsFor(kind, [label, ...(row.names ?? [])]);
    if (!forms.length) continue;
    entries.push(
      Object.freeze({
        kind,
        value,
        label,
        forms: Object.freeze(forms),
        count: total,
        ...(dimension ? { dimension } : {}),
        ...(categoryId ? { categoryId } : {}),
      }),
    );
  }
  // Form words are vocabulary too, so a word inside "t shirt" is never corrected.
  for (const entry of entries)
    for (const form of entry.forms)
      for (const word of lexiconTokens(form))
        if (word.length <= 32) words.add(word);
  if (words.size > SEARCH_LEXICON_LIMITS.maxRows * 4)
    throw new SearchLexiconCapacityError(
      'Search vocabulary words exceed the lexicon ceiling',
    );
  const body = {
    schema: SEARCH_LEXICON_SCHEMA,
    sourceAsOf: input.sourceAsOf.toISOString(),
    entries: Object.freeze(entries),
    synonyms: Object.freeze(
      synonyms.sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0)),
    ),
    words: Object.freeze([...words].sort()),
    price,
    truncatedWords: rows.length > input.maxRows,
  };
  return Object.freeze({
    ...body,
    builtAt: input.builtAt.toISOString(),
    version: digest({
      entries: body.entries,
      synonyms: body.synonyms,
      words: body.words,
      price: body.price,
    }),
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isIso = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const isKey = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= SEARCH_LEXICON_LIMITS.formCharacters &&
  value === formKey(value) &&
  lexiconTokens(value).length <= SEARCH_LEXICON_LIMITS.formTokens;

/**
 * Strict reader for a stored blob. Anything malformed (a hand edit, a partial
 * value, an older shape) is rejected whole instead of half-trusted.
 */
export function parseSearchLexiconBlob(
  raw: string | null | undefined,
): SearchLexiconBlob | null {
  if (typeof raw !== 'string' || raw.length > SEARCH_LEXICON_LIMITS.maxBytes)
    return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.schema !== SEARCH_LEXICON_SCHEMA ||
    !isIso(value.sourceAsOf) ||
    !isIso(value.builtAt) ||
    typeof value.version !== 'string' ||
    !/^[0-9a-f]{24}$/.test(value.version) ||
    typeof value.truncatedWords !== 'boolean' ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.synonyms) ||
    !Array.isArray(value.words) ||
    value.entries.length + value.synonyms.length >
      SEARCH_LEXICON_LIMITS.maxRows ||
    value.words.length > SEARCH_LEXICON_LIMITS.maxRows * 4
  )
    return null;
  const price = value.price;
  if (
    price !== null &&
    (!isRecord(price) ||
      money(price.p30) !== price.p30 ||
      money(price.p80) !== price.p80 ||
      (price.p30 as number) > (price.p80 as number) ||
      !Number.isSafeInteger(price.count) ||
      (price.count as number) < 1)
  )
    return null;
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      !SEARCH_LEXICON_KINDS.includes(entry.kind as SearchLexiconKind) ||
      typeof entry.value !== 'string' ||
      !validValue(entry.kind as SearchLexiconKind, entry.value) ||
      typeof entry.label !== 'string' ||
      entry.label.length > 160 ||
      !Number.isSafeInteger(entry.count) ||
      (entry.count as number) < 1 ||
      !Array.isArray(entry.forms) ||
      !entry.forms.length ||
      entry.forms.length > SEARCH_LEXICON_LIMITS.formsPerEntry ||
      !entry.forms.every((form) =>
        entry.kind === 'size'
          ? typeof form === 'string' &&
            form.length > 0 &&
            form.length <= SEARCH_LEXICON_LIMITS.formCharacters
          : isKey(form),
      ) ||
      (entry.kind === 'dimension'
        ? typeof entry.dimension !== 'string' || !SLUG.test(entry.dimension)
        : entry.dimension !== undefined) ||
      (entry.kind === 'type'
        ? typeof entry.categoryId !== 'string' || !UUID.test(entry.categoryId)
        : entry.categoryId !== undefined)
    )
      return null;
  }
  for (const synonym of value.synonyms)
    if (
      !isRecord(synonym) ||
      !isKey(synonym.term) ||
      !isKey(synonym.canonical) ||
      synonym.term === synonym.canonical
    )
      return null;
  for (const word of value.words)
    if (
      typeof word !== 'string' ||
      !word ||
      word.length > 32 ||
      word !== normalizeLexiconText(word) ||
      word.includes(' ')
    )
      return null;
  return value as unknown as SearchLexiconBlob;
}
