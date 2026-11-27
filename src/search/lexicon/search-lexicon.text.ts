import { SearchQueryNormalizer } from '../core/search-query-normalizer';
import { SEARCH_STOP_WORDS } from '../core/search-token.service';

const normalizer = new SearchQueryNormalizer();

/** Possessives fold away ("men's" is "men"), never into a stray "s" token. */
const POSSESSIVE = /(?<=[\p{L}\p{N}])['’ʼ`]s(?![\p{L}\p{N}])/gu;

/** Query and lexicon forms share one normaliser, so both sides fold alike. */
export function normalizeLexiconText(raw: string | null | undefined): string {
  return normalizer.normalize(String(raw ?? '').replace(POSSESSIVE, ''));
}

export function lexiconTokens(normalized: string): string[] {
  return normalized ? normalized.split(' ').filter(Boolean) : [];
}

/** Conservative English plural folding for matching keys only. */
export function singularize(word: string): string {
  if (word.length <= 3 || /\d/.test(word)) return word;
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (/(sses|shes|ches|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('ss') || word.endsWith('us') || word.endsWith('is'))
    return word;
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

/** Stop words never decide a match: "iro and buba" and "iro buba" share a key. */
export function matchKeyTokens(tokens: readonly string[]): string[] {
  return tokens
    .filter((token) => !SEARCH_STOP_WORDS.has(token))
    .map((token) => singularize(token));
}

export function formKey(raw: string | null | undefined): string {
  return matchKeyTokens(lexiconTokens(normalizeLexiconText(raw))).join(' ');
}

/** pg_trgm-compatible trigram set: each word padded by two leading spaces and one trailing. */
export function trigrams(value: string): Set<string> {
  const result = new Set<string>();
  for (const word of value.split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    const padded = '  ' + word + ' ';
    for (let index = 0; index + 3 <= padded.length; index++)
      result.add(padded.slice(index, index + 3));
  }
  return result;
}

export function trigramSimilarity(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * Optimal-string-alignment distance with an early exit once every cell in a
 * row exceeds the bound. Callers only bound short single tokens (<= 24 chars).
 */
export function boundedEditDistance(
  left: string,
  right: string,
  bound: number,
): number {
  if (Math.abs(left.length - right.length) > bound) return bound + 1;
  const rows = left.length + 1,
    columns = right.length + 1;
  let previousPrevious: number[] = [];
  let previous = Array.from({ length: columns }, (_, index) => index);
  for (let row = 1; row < rows; row++) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column < columns; column++) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      let value = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost,
      );
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      )
        value = Math.min(value, previousPrevious[column - 2] + 1);
      current.push(value);
      if (value < rowMinimum) rowMinimum = value;
    }
    if (rowMinimum > bound) return bound + 1;
    previousPrevious = previous;
    previous = current;
  }
  return previous[columns - 1];
}
