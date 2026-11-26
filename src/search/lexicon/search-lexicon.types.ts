/** system_config key holding the last good lexicon; replaced in one statement. */
export const SEARCH_LEXICON_CONFIG_KEY = 'search.lexicon.v1';
export const SEARCH_LEXICON_SCHEMA = 'search.lexicon.v1' as const;

export const SEARCH_LEXICON_LIMITS = Object.freeze({
  /** Hard ceiling regardless of the caller-supplied maxRows. */
  maxRows: 10_000,
  /** Serialized blob ceiling; a larger build is refused, keeping the last good one. */
  maxBytes: 4 * 1024 * 1024,
  formsPerEntry: 40,
  formCharacters: 120,
  formTokens: 3,
  valueCharacters: 120,
  /** Readers ignore a lexicon older than this; parsing degrades to patterns. */
  maxAgeMs: 6 * 60 * 60_000,
  /** In-process reload interval for API readers. */
  reloadMs: 60_000,
});

export const SEARCH_LEXICON_KINDS = [
  'category',
  'type',
  'dimension',
  'tag',
  'brand',
  'color',
  'size',
] as const;
export type SearchLexiconKind = (typeof SEARCH_LEXICON_KINDS)[number];

export interface SearchLexiconEntry {
  readonly kind: SearchLexiconKind;
  /** Canonical filter value: an id, slug, normalized tag, colour or size label. */
  readonly value: string;
  readonly label: string;
  /** Match keys (normalized, stop-word free, singular), at most three tokens. */
  readonly forms: readonly string[];
  /** Approved eligible catalogue products this entry matches; always >= 1. */
  readonly count: number;
  readonly dimension?: string;
  readonly categoryId?: string;
}

export interface SearchLexiconSynonym {
  readonly term: string;
  readonly canonical: string;
}

export interface SearchLexiconBlob {
  readonly schema: typeof SEARCH_LEXICON_SCHEMA;
  /** Database statement time of the repeatable-read source snapshot. */
  readonly sourceAsOf: string;
  readonly builtAt: string;
  readonly version: string;
  readonly entries: readonly SearchLexiconEntry[];
  /** Approved TERM synonyms (query rewrites); both directions are searched. */
  readonly synonyms: readonly SearchLexiconSynonym[];
  /** Frequent catalogue words. Known words are never fuzzy-corrected. */
  readonly words: readonly string[];
  readonly price: Readonly<{ p30: number; p80: number; count: number }> | null;
  readonly truncatedWords: boolean;
}
