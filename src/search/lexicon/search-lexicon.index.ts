import {
  boundedEditDistance,
  formKey,
  lexiconTokens,
  trigramSimilarity,
  trigrams,
} from './search-lexicon.text';
import type {
  SearchLexiconBlob,
  SearchLexiconEntry,
  SearchLexiconKind,
} from './search-lexicon.types';

export interface SearchLexiconMatch {
  readonly entry: SearchLexiconEntry;
  /** The form is the entry's whole label, not an alias or a label part. */
  readonly full: boolean;
}

export interface SearchLexiconCorrection {
  readonly word: string;
  readonly similarity: number;
  /** Another candidate scored the same; never strong enough to filter. */
  readonly ambiguous: boolean;
}

/** Shortest token that may be corrected; shorter typos are too ambiguous. */
const FUZZY_MIN_LENGTH = 4;
/** Bounded candidate scan per token, whatever the vocabulary size. */
const FUZZY_MAX_CANDIDATES = 512;
const SIMILARITY_EPSILON = 0.001;

/**
 * Typo similarity. pg_trgm similarity scores a one-letter slip in a six-letter
 * word ("agbda") at 0.44, under every threshold, so a bounded edit distance is
 * blended in: one edit on 5+ letters, two edits on 8+ letters.
 */
export function lexiconSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const trigram = trigramSimilarity(trigrams(left), trigrams(right));
  const length = Math.max(left.length, right.length);
  if (Math.min(left.length, right.length) < FUZZY_MIN_LENGTH) return trigram;
  const bound = length >= 8 ? 2 : 1;
  const distance = boundedEditDistance(left, right, bound);
  const edit = distance <= bound ? 1 - distance / Math.max(length, 5) : 0;
  return Math.round(Math.max(trigram, edit) * 1000) / 1000;
}

/** Immutable request-side view of one stored lexicon. */
export class SearchLexiconIndex {
  readonly version: string;
  readonly sourceAsOf: string;
  readonly price: SearchLexiconBlob['price'];
  private readonly forms = new Map<string, SearchLexiconMatch[]>();
  private readonly compactForms = new Map<string, string>();
  private readonly known = new Set<string>();
  private readonly synonymMap = new Map<string, string[]>();
  private readonly correctable: string[] = [];
  private readonly grams = new Map<string, number[]>();
  private readonly entriesByKind = new Map<
    SearchLexiconKind,
    SearchLexiconEntry[]
  >();

  constructor(blob: SearchLexiconBlob) {
    this.version = blob.version;
    this.sourceAsOf = blob.sourceAsOf;
    this.price = blob.price;
    const correctable = new Set<string>();
    for (const entry of blob.entries) {
      const list = this.entriesByKind.get(entry.kind) ?? [];
      list.push(entry);
      this.entriesByKind.set(entry.kind, list);
      const label = entry.kind === 'size' ? null : formKey(entry.label);
      // "blue" also finds "royal blue" and "sky blue" (never the reverse).
      const heads =
        entry.kind === 'color'
          ? entry.forms
              .filter((form) => form.includes(' '))
              .map((form) => form.slice(form.lastIndexOf(' ') + 1))
          : [];
      for (const form of [...entry.forms, ...heads]) {
        const matches = this.forms.get(form) ?? [];
        if (matches.some((match) => match.entry === entry)) continue;
        matches.push({
          entry,
          full:
            entry.forms.includes(form) && (label === null || label === form),
        });
        this.forms.set(form, matches);
        const compact = form.replace(/ /g, '');
        if (compact !== form && compact.length >= 5)
          this.compactForms.set(compact, form);
        for (const word of lexiconTokens(form)) {
          this.known.add(word);
          if (word.length >= FUZZY_MIN_LENGTH && !/\d/.test(word))
            correctable.add(word);
        }
      }
    }
    for (const word of blob.words) this.known.add(formKey(word) || word);
    for (const { term, canonical } of blob.synonyms) {
      for (const [from, to] of [
        [term, canonical],
        [canonical, term],
      ]) {
        const list = this.synonymMap.get(from) ?? [];
        if (!list.includes(to)) list.push(to);
        this.synonymMap.set(from, list);
      }
      for (const word of [
        ...lexiconTokens(term),
        ...lexiconTokens(canonical),
      ]) {
        this.known.add(word);
        if (word.length >= FUZZY_MIN_LENGTH && !/\d/.test(word))
          correctable.add(word);
      }
    }
    this.correctable = [...correctable].sort();
    this.correctable.forEach((word, position) => {
      for (const gram of trigrams(word)) {
        const list = this.grams.get(gram) ?? [];
        list.push(position);
        this.grams.set(gram, list);
      }
    });
  }

  lookup(key: string): readonly SearchLexiconMatch[] {
    return this.forms.get(key) ?? [];
  }

  /** "tshirt" finds "t shirt"; "aso ebi" finds "asoebi". */
  compact(key: string): string | null {
    const joined = key.replace(/ /g, '');
    if (joined.length < 5) return null;
    if (this.forms.has(joined) && joined !== key) return joined;
    const spaced = this.compactForms.get(joined);
    return spaced && spaced !== key ? spaced : null;
  }

  synonyms(key: string): readonly string[] {
    return this.synonymMap.get(key) ?? [];
  }

  isKnown(word: string): boolean {
    return this.known.has(word);
  }

  entries(kind: SearchLexiconKind): readonly SearchLexiconEntry[] {
    return this.entriesByKind.get(kind) ?? [];
  }

  /** Best lexicon word for an unknown token, or null below the floor. */
  correct(word: string, floor: number): SearchLexiconCorrection | null {
    if (
      word.length < FUZZY_MIN_LENGTH ||
      /\d/.test(word) ||
      this.known.has(word)
    )
      return null;
    const shared = new Map<number, number>();
    for (const gram of trigrams(word))
      for (const position of this.grams.get(gram) ?? [])
        shared.set(position, (shared.get(position) ?? 0) + 1);
    const candidates = [...shared]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, FUZZY_MAX_CANDIDATES);
    let best: SearchLexiconCorrection | null = null;
    for (const [position] of candidates) {
      const candidate = this.correctable[position];
      const similarity = lexiconSimilarity(word, candidate);
      if (similarity < floor) continue;
      if (!best || similarity > best.similarity + SIMILARITY_EPSILON)
        best = { word: candidate, similarity, ambiguous: false };
      else if (Math.abs(similarity - best.similarity) <= SIMILARITY_EPSILON)
        best = { ...best, ambiguous: true };
    }
    return best;
  }
}
