import type {
  CanonicalMarketFilters,
  MarketAudience,
  MarketFulfilment,
} from '../../market/catalog/market-filters';
import { SEARCH_GENERIC_COMMERCE_TERMS } from '../core/search-token.service';
import type { SearchLexiconIndex } from './search-lexicon.index';
import { normalizeLexiconText, singularize } from './search-lexicon.text';
import type { SearchLexiconEntry } from './search-lexicon.types';

/** Query-understanding limits (search spec section 9). */
export const SEARCH_PARSE_LIMITS = Object.freeze({
  tokens: 12,
  span: 3,
  valuesPerKey: 8,
  hard: 0.8,
  soft: 0.5,
  /** Literal spans a shopper asked to keep as plain words. */
  literals: 12,
});

/** Section 3.3: a residual word is auto-corrected only at this similarity. */
const SEARCH_AUTOCORRECT_SIMILARITY = 0.7;
/** Matches the product search statement's per-group alternative ceiling. */
const RESIDUAL_ALTERNATIVES = 4;

export type SearchAttributeType =
  | 'category'
  | 'garmentType'
  | 'dimension'
  | 'tag'
  | 'brand'
  | 'color'
  | 'size'
  | 'audience'
  | 'price'
  | 'fulfilment'
  | 'onSale';

export type SearchAttributeApplied =
  /** A hard filter: every returned item satisfies it. */
  | 'filter'
  /** Ranked higher, never required; shown as "Did you mean ...?". */
  | 'boost'
  /** Already implied by a narrower filter (a garment type's own category). */
  | 'implied'
  /** The request's explicit filter for the same key replaced it. */
  | 'overridden';

export interface SearchParsedAttribute {
  readonly type: SearchAttributeType;
  readonly value: string;
  readonly label: string;
  readonly confidence: number;
  applied: SearchAttributeApplied;
  /** The words of the query this attribute came from. */
  readonly text: string;
  readonly values: readonly string[];
  readonly dimension?: string;
  readonly price?: Readonly<{ min?: number; max?: number }>;
}

export interface SearchParsedCorrection {
  readonly from: string;
  readonly to: string;
  readonly similarity: number;
  /** True when the corrected word was already used as a filter. */
  readonly applied: boolean;
}

export interface SearchSoftBoosts {
  readonly categoryIds: readonly string[];
  readonly categoryTypeIds: readonly string[];
  readonly brandIds: readonly string[];
  readonly tags: readonly string[];
  readonly colors: readonly string[];
  readonly sizes: readonly string[];
  readonly audience: readonly MarketAudience[];
  readonly dimensions: Readonly<Record<string, readonly string[]>>;
  readonly price: Readonly<{ min?: number; max?: number }> | null;
}

export interface SearchParsedQuery {
  readonly normalizedQuery: string;
  readonly attributes: readonly SearchParsedAttribute[];
  /** Words still searched as text, in query order. */
  readonly residual: string;
  /** Each residual word with its synonyms; every group must match. */
  readonly residualGroups: readonly (readonly string[])[];
  readonly filters: CanonicalMarketFilters;
  readonly boosts: SearchSoftBoosts;
  readonly corrections: readonly SearchParsedCorrection[];
  readonly truncated: boolean;
  readonly lexiconVersion: string | null;
}

export interface SearchParseOptions {
  /** Filter keys the request sets explicitly; parsed values for them yield. */
  readonly explicitKeys?: ReadonlySet<keyof CanonicalMarketFilters>;
  /** Normalized spans the shopper asked to keep as text ("red", "size 42"). */
  readonly literals?: readonly string[];
}

interface Token {
  readonly raw: string;
  /** Normalized word ('' for a symbol). */
  readonly word: string;
  /** Matching key: singular, '' for stop words and symbols. */
  readonly key: string;
  readonly money: Readonly<{ amount: number; marked: boolean }> | null;
  used: boolean;
}

type Kind = SearchLexiconEntry['kind'] | 'intent';
interface Candidate {
  readonly start: number;
  /** Exclusive token end. */
  readonly end: number;
  readonly length: number;
  readonly confidence: number;
  readonly rank: number;
  readonly build: () => SearchParsedAttribute[];
  readonly correction?: SearchParsedCorrection;
}

const STOP = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'by',
  'for',
  'from',
  'in',
  'is',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);
/** Conversational filler and generic words: never required as text when an
 * attribute was understood, matching the existing distinctive-token rule. */
const FILLER = new Set([
  ...SEARCH_GENERIC_COMMERCE_TERMS,
  'outfit',
  'outfits',
  'styles',
  'clothing',
  'attire',
  'apparel',
  'garment',
  'garments',
  'i',
  'me',
  'my',
  'want',
  'need',
  'looking',
  'show',
  'find',
  'buy',
  'get',
  'please',
  'some',
  'any',
  'something',
  'nice',
  'new',
]);
const AUDIENCE: Record<string, MarketAudience> = {};
for (const word of [
  'men',
  'man',
  'mens',
  'male',
  'males',
  'him',
  'his',
  'boy',
  'boys',
  'gent',
  'gents',
  'gentleman',
  'gentlemen',
  'guys',
  'menswear',
])
  AUDIENCE[word] = 'MEN';
for (const word of [
  'women',
  'woman',
  'womens',
  'female',
  'females',
  'her',
  'hers',
  'lady',
  'ladies',
  'girl',
  'girls',
  'womenswear',
])
  AUDIENCE[word] = 'WOMEN';
for (const word of ['unisex', 'everybody', 'everyone', 'genderless'])
  AUDIENCE[word] = 'UNISEX';
const AUDIENCE_LABEL: Record<MarketAudience, string> = {
  MEN: 'Menswear',
  WOMEN: 'Womenswear',
  UNISEX: 'Unisex',
};

const INTENT_PHRASES: ReadonlyArray<
  readonly [string, 'fulfilment' | 'onSale', MarketFulfilment | 'true']
> = [
  ['ready to wear', 'fulfilment', 'READY_TO_WEAR'],
  ['ready made', 'fulfilment', 'READY_TO_WEAR'],
  ['readymade', 'fulfilment', 'READY_TO_WEAR'],
  ['rtw', 'fulfilment', 'READY_TO_WEAR'],
  ['in stock', 'fulfilment', 'READY_TO_WEAR'],
  ['off the rack', 'fulfilment', 'READY_TO_WEAR'],
  ['custom', 'fulfilment', 'MADE_TO_ORDER'],
  ['custom made', 'fulfilment', 'MADE_TO_ORDER'],
  ['custom order', 'fulfilment', 'MADE_TO_ORDER'],
  ['made to measure', 'fulfilment', 'MADE_TO_ORDER'],
  ['made to order', 'fulfilment', 'MADE_TO_ORDER'],
  ['tailor made', 'fulfilment', 'MADE_TO_ORDER'],
  ['bespoke', 'fulfilment', 'MADE_TO_ORDER'],
  ['sale', 'onSale', 'true'],
  ['on sale', 'onSale', 'true'],
  ['discount', 'onSale', 'true'],
  ['discounted', 'onSale', 'true'],
  ['deal', 'onSale', 'true'],
  ['deals', 'onSale', 'true'],
  ['promo', 'onSale', 'true'],
  ['clearance', 'onSale', 'true'],
];
const MAX_CUES = new Set([
  'up',
  'under',
  'below',
  'less',
  'max',
  'maximum',
  'within',
  'budget',
  'upto',
  'cheaper',
  'lt',
]);
const MIN_CUES = new Set([
  'over',
  'above',
  'more',
  'min',
  'minimum',
  'least',
  'starting',
  'from',
  'gt',
]);
const CHEAP = new Set([
  'affordable',
  'cheap',
  'budget',
  'inexpensive',
  'cheapest',
]);
const LUXURY = new Set([
  'luxury',
  'luxurious',
  'premium',
  'designer',
  'highend',
]);
const CURRENCY = new Set(['naira', 'ngn', 'n']);
const ALPHA_SIZES: Record<string, string> = {
  xxs: 'xxs',
  xs: 'xs',
  s: 's',
  m: 'm',
  l: 'l',
  xl: 'xl',
  xxl: 'xxl',
  '2xl': 'xxl',
  xxxl: 'xxxl',
  '3xl': 'xxxl',
  '4xl': '4xl',
  '5xl': '5xl',
  small: 's',
  medium: 'm',
  large: 'l',
};
const PLUS_SIZES = [
  'xxl',
  '2xl',
  'xxxl',
  '3xl',
  '4xl',
  '5xl',
  '1x',
  '2x',
  '3x',
  '4x',
];
const SIZE_SYSTEMS = new Set(['uk', 'us', 'eu']);
const MONEY_LIMIT = 99_999_999.99;

const KIND_RANK: Record<Kind, number> = {
  category: 0,
  type: 1,
  color: 3,
  intent: 4,
  dimension: 5,
  brand: 6,
  tag: 7,
  size: 8,
};

const freezeList = <T>(values: Iterable<T>) =>
  Object.freeze([...new Set(values)]);

function moneyOf(word: string): { amount: number; marked: boolean } | null {
  const match =
    /^(n|ngn)?(\d{1,3}(?:,\d{3})+|\d{1,12})(?:\.(\d{1,2}))?(k|m)?$/.exec(word);
  if (!match) return null;
  let amount = Number(
    match[2].replace(/,/g, '') + (match[3] ? '.' + match[3] : ''),
  );
  if (match[4] === 'k') amount *= 1_000;
  if (match[4] === 'm') amount *= 1_000_000;
  if (!Number.isFinite(amount) || amount < 0 || amount > MONEY_LIMIT)
    return null;
  return {
    amount: Math.round(amount * 100) / 100,
    marked: Boolean(match[1] || match[4] || match[2].includes(',')),
  };
}

/** Lower-cased NFKC text with money and ranges kept intact ("₦20,000-30k"). */
function tokenize(raw: string): Token[] {
  const folded = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(?<=\d[km]?)\s*(?:-|–|—)\s*(?=[₦n]?\d)/gu, ' to ')
    .replace(/₦\s*/gu, 'n')
    .replace(/(?<=[\p{L}\p{N}])['’ʼ`]s(?![\p{L}\p{N}])/gu, '');
  const tokens: Token[] = [];
  for (const match of folded.matchAll(
    /[<>≤≥]|[\p{L}\p{N}]+(?:[.,]\p{N}+\p{L}*)*/gu,
  )) {
    const raw = match[0];
    if (/^[<≤]$/.test(raw) || /^[>≥]$/.test(raw)) {
      const word = /^[<≤]$/.test(raw) ? 'lt' : 'gt';
      tokens.push({ raw, word, key: '', money: null, used: false });
      continue;
    }
    const money = moneyOf(raw);
    if (money) {
      tokens.push({ raw, word: raw, key: '', money, used: false });
      continue;
    }
    for (const word of normalizeLexiconText(raw).split(' ').filter(Boolean))
      tokens.push({
        raw: word,
        word,
        key: STOP.has(word) ? '' : singularize(word),
        money: moneyOf(word),
        used: false,
      });
  }
  return tokens;
}

function label(entry: SearchLexiconEntry): string {
  return entry.label;
}

/**
 * Deterministic query understanding over the stored lexicon. Never reads the
 * database and never throws on hostile input: anything not understood stays
 * text, which the canonical retrieval tiers then search.
 */
export function parseSearchQuery(
  rawQuery: string,
  index: SearchLexiconIndex | null,
  options: SearchParseOptions = {},
): SearchParsedQuery {
  const all = tokenize(String(rawQuery ?? '').slice(0, 200));
  let content = 0;
  let truncated = false;
  const tokens: Token[] = [];
  for (const token of all) {
    if (token.key || token.money) content++;
    if (content > SEARCH_PARSE_LIMITS.tokens) {
      truncated = true;
      break;
    }
    tokens.push(token);
  }
  const normalizedQuery = tokens.map((token) => token.word).join(' ');
  const attributes: SearchParsedAttribute[] = [];
  const corrections: SearchParsedCorrection[] = [];
  const literals = new Set(
    (options.literals ?? [])
      .slice(0, SEARCH_PARSE_LIMITS.literals)
      .map((value) => normalizeLexiconText(value))
      .filter(Boolean),
  );
  const literal = new Array<boolean>(tokens.length).fill(false);
  for (const phrase of literals) {
    const words = phrase.split(' ');
    for (let start = 0; start + words.length <= tokens.length; start++)
      if (words.every((word, offset) => tokens[start + offset].word === word))
        for (let offset = 0; offset < words.length; offset++)
          literal[start + offset] = true;
  }
  const free = (start: number, end: number) => {
    for (let position = start; position < end; position++)
      if (tokens[position].used || literal[position]) return false;
    return true;
  };
  const take = (start: number, end: number) => {
    for (let position = start; position < end; position++)
      tokens[position].used = true;
  };
  const text = (start: number, end: number) =>
    tokens
      .slice(start, end)
      .map((token) => token.word)
      .join(' ');

  // 1. Explicit size phrases claim their numbers before any price reading.
  const sizeEntries = index?.entries('size') ?? [];
  const sizeValues = (forms: readonly string[]) => {
    const wanted = new Set(forms);
    return sizeEntries
      .filter((entry) => entry.forms.some((form) => wanted.has(form)))
      .sort((a, b) => b.count - a.count)
      .slice(0, SEARCH_PARSE_LIMITS.valuesPerKey)
      .map((entry) => entry.value);
  };
  const addSize = (
    start: number,
    end: number,
    forms: string[],
    typed: string,
    explicit: boolean,
  ) => {
    const values = sizeValues(forms);
    const confidence = values.length || explicit ? 1 : 0.6;
    attributes.push({
      type: 'size',
      value: values[0] ?? typed,
      label: `Size ${(values[0] ?? typed).toUpperCase()}`,
      confidence,
      applied: confidence >= SEARCH_PARSE_LIMITS.hard ? 'filter' : 'boost',
      text: text(start, end),
      values: values.length ? values : [typed.toUpperCase()],
    });
    take(start, end);
  };
  const sizeForms = (word: string, system?: string): string[] => {
    const alpha = ALPHA_SIZES[word];
    if (alpha) {
      const twin = Object.keys(ALPHA_SIZES).filter(
        (key) =>
          ALPHA_SIZES[key] === alpha && !/^(small|medium|large)$/.test(key),
      );
      return [...new Set([alpha, ...twin])];
    }
    if (!/^\d{1,3}(?:\.5)?$/.test(word)) return [];
    return system
      ? [`${system} ${word}`, `${system}${word}`]
      : [
          word,
          ...[...SIZE_SYSTEMS].flatMap((name) => [
            `${name} ${word}`,
            `${name}${word}`,
          ]),
        ];
  };
  for (let position = 0; position < tokens.length; position++) {
    const token = tokens[position];
    if (!free(position, position + 1)) continue;
    const next = tokens[position + 1];
    const after = tokens[position + 2];
    if (token.word === 'size' && next && free(position + 1, position + 2)) {
      if (
        SIZE_SYSTEMS.has(next.word) &&
        after &&
        sizeForms(after.word, next.word).length
      ) {
        addSize(
          position,
          position + 3,
          sizeForms(after.word, next.word),
          `${next.word} ${after.word}`,
          true,
        );
        continue;
      }
      const forms = sizeForms(next.word);
      if (forms.length) {
        addSize(
          position,
          position + 2,
          forms,
          ALPHA_SIZES[next.word] ?? next.word,
          true,
        );
        continue;
      }
    }
    if (
      ['small', 'medium', 'large'].includes(token.word) &&
      next?.word === 'size' &&
      free(position + 1, position + 2)
    ) {
      addSize(
        position,
        position + 2,
        sizeForms(token.word),
        ALPHA_SIZES[token.word],
        true,
      );
      continue;
    }
    if (
      SIZE_SYSTEMS.has(token.word) &&
      next &&
      /^\d{1,3}(?:\.5)?$/.test(next.word) &&
      free(position + 1, position + 2)
    ) {
      addSize(
        position,
        position + 2,
        sizeForms(next.word, token.word),
        `${token.word} ${next.word}`,
        true,
      );
      continue;
    }
    const system = /^(uk|us|eu)(\d{1,3})$/.exec(token.word);
    if (system) {
      addSize(
        position,
        position + 1,
        sizeForms(system[2], system[1]),
        `${system[1]} ${system[2]}`,
        true,
      );
      continue;
    }
    if (
      token.word === 'plus' &&
      next?.word === 'size' &&
      free(position + 1, position + 2)
    ) {
      const values = sizeValues(PLUS_SIZES);
      if (values.length) {
        attributes.push({
          type: 'size',
          value: values[0],
          label: 'Plus size',
          confidence: 1,
          applied: 'filter',
          text: 'plus size',
          values,
        });
        take(position, position + 2);
      }
      continue;
    }
    if (/^(xxs|xs|xl|xxl|xxxl|[2-5]xl)$/.test(token.word)) {
      const forms = sizeForms(token.word);
      const values = sizeValues(forms);
      attributes.push({
        type: 'size',
        value: values[0] ?? ALPHA_SIZES[token.word],
        label: `Size ${(values[0] ?? ALPHA_SIZES[token.word]).toUpperCase()}`,
        confidence: values.length ? 1 : 0.6,
        applied: values.length ? 'filter' : 'boost',
        text: token.word,
        values: values.length
          ? values
          : [ALPHA_SIZES[token.word].toUpperCase()],
      });
      take(position, position + 1);
    }
  }

  // 2. Lexicon n-grams and fixed intents, globally longest first.
  const candidates: Candidate[] = [];
  const keyed: number[] = [];
  tokens.forEach((token, position) => {
    if (token.key && !token.money) keyed.push(position);
  });
  const fuzzyCache = new Map<
    string,
    ReturnType<SearchLexiconIndex['correct']>
  >();
  const fuzzy = (key: string) => {
    if (!index) return null;
    if (!fuzzyCache.has(key))
      fuzzyCache.set(key, index.correct(key, SEARCH_PARSE_LIMITS.soft));
    return fuzzyCache.get(key) ?? null;
  };
  const lexiconCandidate = (
    start: number,
    end: number,
    length: number,
    matches: ReturnType<SearchLexiconIndex['lookup']>,
    confidence: number,
    correction?: SearchParsedCorrection,
  ) => {
    // Sizes come only from the size patterns: a bare "m" is not a size.
    matches = matches.filter((match) => match.entry.kind !== 'size');
    if (!matches.length) return;
    const byKind = new Map<Kind, typeof matches>();
    for (const match of matches) {
      const kind = match.entry.kind;
      byKind.set(kind, [...(byKind.get(kind) ?? []), match]);
    }
    const ranked = [...byKind.entries()]
      .map(([kind, list]) => ({
        kind,
        list,
        // A category's whole name outranks a garment type; its part does not.
        rank:
          kind === 'category'
            ? list.some((match) => match.full)
              ? 0
              : 2
            : KIND_RANK[kind],
      }))
      .filter(
        ({ kind }) => !(kind === 'brand' && confidence < 1 && byKind.size > 1),
      )
      .sort((a, b) => a.rank - b.rank);
    const best = ranked[0];
    if (!best) return;
    candidates.push({
      start,
      end,
      length,
      confidence,
      rank: best.rank,
      correction,
      build: () =>
        buildLexicon(
          best.kind as SearchLexiconEntry['kind'],
          best.list,
          confidence,
          text(start, end),
        ),
    });
  };
  for (let first = 0; first < keyed.length; first++) {
    for (
      let width = 1;
      width <= SEARCH_PARSE_LIMITS.span && first + width <= keyed.length;
      width++
    ) {
      const positions = keyed.slice(first, first + width);
      const start = positions[0];
      const end = positions[positions.length - 1] + 1;
      if (!free(start, end)) break;
      const keys = positions.map((position) => tokens[position].key);
      const key = keys.join(' ');
      const words = tokens
        .slice(start, end)
        .map((token) => token.word)
        .join(' ');
      const before = tokens[start - 1];
      const leading =
        before && !before.key && !before.money && free(start - 1, start)
          ? `${before.word} ${words}`
          : null;
      for (const [phrase, kind, value] of INTENT_PHRASES)
        if (phrase === words || phrase === key || phrase === leading)
          candidates.push({
            start: phrase === leading ? start - 1 : start,
            end,
            length: width,
            confidence: 1,
            rank: KIND_RANK.intent,
            build: () => [
              kind === 'onSale'
                ? {
                    type: 'onSale',
                    value: 'true',
                    label: 'On sale',
                    confidence: 1,
                    applied: 'filter',
                    text: words,
                    values: ['true'],
                  }
                : {
                    type: 'fulfilment',
                    value,
                    label:
                      value === 'READY_TO_WEAR'
                        ? 'Ready to wear'
                        : 'Made to order',
                    confidence: 1,
                    applied: 'filter',
                    text: words,
                    values: [value],
                  },
            ],
          });
      if (width === 1 && AUDIENCE[tokens[start].word]) {
        const audience = AUDIENCE[tokens[start].word];
        candidates.push({
          start,
          end,
          length: 1,
          confidence: 1,
          rank: KIND_RANK.intent,
          build: () => [
            {
              type: 'audience',
              value: audience,
              label: AUDIENCE_LABEL[audience],
              confidence: 1,
              applied: 'filter',
              text: tokens[start].word,
              values: [audience],
            },
          ],
        });
      }
      if (!index) continue;
      lexiconCandidate(start, end, width, index.lookup(key), 1);
      const compact = index.compact(key);
      if (compact)
        lexiconCandidate(start, end, width, index.lookup(compact), 0.95);
      for (const synonym of index.synonyms(key))
        lexiconCandidate(start, end, width, index.lookup(synonym), 1);
      // One word swapped for its synonym: "evening dress" is "evening gown".
      if (width > 1)
        keys.forEach((word, offset) => {
          for (const synonym of index.synonyms(word)) {
            const swapped = [...keys];
            swapped[offset] = synonym;
            lexiconCandidate(
              start,
              end,
              width,
              index.lookup(swapped.join(' ')),
              1,
            );
          }
        });
      // One unknown word corrected; the rest must be exact.
      const unknown = keys
        .map((word, offset) => ({ word, offset }))
        .filter(({ word }) => !index.isKnown(word));
      if (unknown.length === 1) {
        const correction = fuzzy(unknown[0].word);
        if (correction) {
          const fixed = [...keys];
          fixed[unknown[0].offset] = correction.word;
          const similarity = correction.ambiguous
            ? Math.min(correction.similarity, 0.79)
            : correction.similarity;
          lexiconCandidate(
            start,
            end,
            width,
            index.lookup(fixed.join(' ')),
            similarity,
            {
              from: tokens[positions[unknown[0].offset]].word,
              to: correction.word,
              similarity: correction.similarity,
              applied: similarity >= SEARCH_PARSE_LIMITS.hard,
            },
          );
        }
      }
    }
  }
  candidates.sort(
    (a, b) =>
      b.length - a.length ||
      b.confidence - a.confidence ||
      a.rank - b.rank ||
      a.start - b.start,
  );
  const softTokens = new Set<number>();
  for (const candidate of candidates) {
    if (!free(candidate.start, candidate.end)) continue;
    const built = candidate.build();
    if (!built.length) continue;
    take(candidate.start, candidate.end);
    attributes.push(...built);
    if (candidate.correction) corrections.push(candidate.correction);
    if (candidate.confidence < SEARCH_PARSE_LIMITS.hard)
      for (let position = candidate.start; position < candidate.end; position++)
        if (tokens[position].key) softTokens.add(position);
  }

  // 3. Price, parsed last; a number it claims is never searched as text.
  let minimum: number | undefined;
  let maximum: number | undefined;
  const priceText: string[] = [];
  let priceConfidence = 1;
  const priceLabel = (amount: number) =>
    amount >= 1_000_000 && amount % 100_000 === 0
      ? `₦${amount / 1_000_000}m`
      : amount >= 1_000 && amount % 1_000 === 0
        ? `₦${amount / 1_000}k`
        : `₦${amount.toLocaleString('en-NG')}`;
  for (let position = 0; position < tokens.length; position++) {
    const token = tokens[position];
    if (!free(position, position + 1)) continue;
    const word = token.word;
    const numberAt = (at: number) => {
      const candidate = tokens[at];
      if (!candidate || !free(at, at + 1)) return null;
      if (candidate.money) return { at, ...candidate.money };
      if (
        CURRENCY.has(candidate.word) &&
        tokens[at + 1]?.money &&
        free(at + 1, at + 2)
      )
        return { at: at + 1, ...tokens[at + 1].money!, marked: true };
      return null;
    };
    const unit = (at: number) =>
      CURRENCY.has(tokens[at + 1]?.word ?? '') && free(at + 1, at + 2)
        ? at + 1
        : at;
    if (MAX_CUES.has(word) || MIN_CUES.has(word)) {
      let skip = position + 1;
      while (
        tokens[skip] &&
        ['than', 'to', 'of', 'at', 'n', 'naira'].includes(tokens[skip].word) &&
        !tokens[skip].money
      )
        skip++;
      if (word === 'up' && tokens[position + 1]?.word !== 'to') continue;
      const amount = numberAt(skip);
      if (!amount) continue;
      if (word === 'from' && !amount.marked && amount.amount < 1000) continue;
      const last = unit(amount.at);
      if (MAX_CUES.has(word))
        maximum =
          maximum === undefined
            ? amount.amount
            : Math.min(maximum, amount.amount);
      else
        minimum =
          minimum === undefined
            ? amount.amount
            : Math.max(minimum, amount.amount);
      priceText.push(text(position, last + 1));
      take(position, last + 1);
      continue;
    }
    if (
      word === 'between' ||
      token.money ||
      (CURRENCY.has(word) && tokens[position + 1]?.money)
    ) {
      const first = numberAt(word === 'between' ? position + 1 : position);
      if (!first) continue;
      let link = first.at + 1;
      if (CURRENCY.has(tokens[link]?.word ?? '') && free(link, link + 1))
        link++;
      const joiner = tokens[link]?.word;
      const second =
        ['to', 'and'].includes(joiner ?? '') && free(link, link + 1)
          ? numberAt(link + 1)
          : null;
      if (
        second &&
        (first.marked ||
          second.marked ||
          Math.min(first.amount, second.amount) >= 1000)
      ) {
        const last = unit(second.at);
        minimum = Math.min(first.amount, second.amount);
        maximum = Math.max(first.amount, second.amount);
        priceText.push(text(position, last + 1));
        take(position, last + 1);
        position = last;
        continue;
      }
      if (word !== 'between' && first.marked) {
        // "ankara 20k": a likely ceiling, offered as a boost.
        const last = unit(first.at);
        if (maximum === undefined) {
          maximum = first.amount;
          priceConfidence = 0.7;
        }
        priceText.push(text(position, last + 1));
        take(position, last + 1);
        position = last;
      }
    }
  }
  for (let position = 0; position < tokens.length; position++) {
    const word = tokens[position].word;
    if (!free(position, position + 1) || !index?.price) continue;
    if (CHEAP.has(word) && maximum === undefined) {
      maximum = index.price.p30;
      priceText.push(word);
      take(position, position + 1);
    } else if (
      LUXURY.has(word) &&
      minimum === undefined &&
      !index.lookup(tokens[position].key).length
    ) {
      minimum = index.price.p80;
      priceText.push(word);
      take(position, position + 1);
    }
  }
  if (minimum !== undefined || maximum !== undefined) {
    const price = {
      ...(minimum !== undefined ? { min: minimum } : {}),
      ...(maximum !== undefined ? { max: maximum } : {}),
    };
    attributes.push({
      type: 'price',
      value: `${minimum ?? ''}-${maximum ?? ''}`,
      label:
        minimum !== undefined && maximum !== undefined
          ? `${priceLabel(minimum)}–${priceLabel(maximum)}`
          : maximum !== undefined
            ? `Under ${priceLabel(maximum)}`
            : `Over ${priceLabel(minimum!)}`,
      confidence: priceConfidence,
      applied: priceConfidence >= SEARCH_PARSE_LIMITS.hard ? 'filter' : 'boost',
      text: priceText.join(' '),
      values: [],
      price: Object.freeze(price),
    });
  }

  // 4. A bare 36-50 is a shoe or dress size only when nothing else used it.
  for (let position = 0; position < tokens.length; position++) {
    const token = tokens[position];
    if (!free(position, position + 1) || !/^\d{2}$/.test(token.word)) continue;
    const value = Number(token.word);
    if (value >= 36 && value <= 50)
      addSize(position, position + 1, sizeForms(token.word), token.word, false);
  }

  return assemble({
    normalizedQuery,
    tokens,
    literal,
    softTokens,
    attributes,
    corrections,
    truncated,
    index,
    options,
  });
}

function buildLexicon(
  kind: SearchLexiconEntry['kind'],
  matches: ReturnType<SearchLexiconIndex['lookup']>,
  confidence: number,
  text: string,
): SearchParsedAttribute[] {
  const applied: SearchAttributeApplied =
    confidence >= SEARCH_PARSE_LIMITS.hard ? 'filter' : 'boost';
  let entries = [
    ...new Map(
      matches.map((match) => [
        match.entry.value + '\u0000' + (match.entry.dimension ?? ''),
        match.entry,
      ]),
    ).values(),
  ];
  if (kind === 'dimension') {
    // One dimension per span; prefer a whole-label match, then the larger one.
    const full = new Set(
      matches.filter((match) => match.full).map((match) => match.entry),
    );
    entries.sort(
      (a, b) =>
        Number(full.has(b)) - Number(full.has(a)) ||
        b.count - a.count ||
        (a.dimension! < b.dimension! ? -1 : 1),
    );
    const dimension = entries[0].dimension;
    entries = entries.filter((entry) => entry.dimension === dimension);
  }
  entries = [...new Set(entries)]
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))
    .slice(0, SEARCH_PARSE_LIMITS.valuesPerKey);
  const primary = entries[0];
  const type: SearchAttributeType =
    kind === 'type' ? 'garmentType' : (kind as SearchAttributeType);
  const titled = (value: string) =>
    value.replace(/(^|\s)\p{L}/gu, (letter) => letter.toUpperCase());
  const exact = matches.some((match) => match.full && match.entry === primary);
  return [
    {
      type,
      value: primary.value,
      // "blue" matched "Sky Blue" and "Royal Blue": the chip says "Blue".
      label:
        kind === 'color'
          ? titled(exact || entries.length === 1 ? primary.label : text)
          : label(primary),
      confidence,
      applied,
      text,
      values: entries.map((entry) => entry.value),
      ...(kind === 'dimension' ? { dimension: primary.dimension } : {}),
    },
  ];
}

function assemble(input: {
  normalizedQuery: string;
  tokens: Token[];
  literal: boolean[];
  softTokens: Set<number>;
  attributes: SearchParsedAttribute[];
  corrections: SearchParsedCorrection[];
  truncated: boolean;
  index: SearchLexiconIndex | null;
  options: SearchParseOptions;
}): SearchParsedQuery {
  const { attributes, index, options } = input;
  const explicit = options.explicitKeys ?? new Set();
  const keyOf: Record<SearchAttributeType, keyof CanonicalMarketFilters> = {
    category: 'categoryIds',
    garmentType: 'categoryTypeIds',
    dimension: 'dimensions',
    tag: 'tags',
    brand: 'brandIds',
    color: 'colors',
    size: 'sizes',
    audience: 'audience',
    price: 'price',
    fulfilment: 'fulfilment',
    onSale: 'onSale',
  };
  for (const attribute of attributes)
    if (explicit.has(keyOf[attribute.type])) attribute.applied = 'overridden';
  // A garment type implies its own category; a contradictory category becomes a boost.
  const hardTypes = attributes.filter(
    (item) => item.type === 'garmentType' && item.applied === 'filter',
  );
  if (hardTypes.length) {
    const typeCategories = new Set(
      hardTypes.flatMap((item) =>
        item.values.map(
          (value) =>
            index?.entries('type').find((entry) => entry.value === value)
              ?.categoryId,
        ),
      ),
    );
    for (const item of attributes)
      if (item.type === 'category' && item.applied === 'filter')
        item.applied = item.values.some((value) => typeCategories.has(value))
          ? 'implied'
          : 'boost';
  }
  // Fulfilment can hold one value; two different ones cancel to a boost.
  const fulfilments = attributes.filter(
    (item) => item.type === 'fulfilment' && item.applied === 'filter',
  );
  if (new Set(fulfilments.map((item) => item.value)).size > 1)
    for (const item of fulfilments) item.applied = 'boost';

  const hard = attributes.filter((item) => item.applied === 'filter');
  const soft = attributes.filter((item) => item.applied === 'boost');
  const collect = (list: SearchParsedAttribute[], type: SearchAttributeType) =>
    list.filter((item) => item.type === type).flatMap((item) => item.values);
  const limited = (values: string[]) =>
    freezeList(values).slice(0, SEARCH_PARSE_LIMITS.valuesPerKey);
  const dimensions = (list: SearchParsedAttribute[]) => {
    const result: Record<string, string[]> = {};
    for (const item of list.filter((entry) => entry.type === 'dimension'))
      result[item.dimension!] = limited([
        ...(result[item.dimension!] ?? []),
        ...item.values,
      ]) as string[];
    return Object.freeze(
      Object.fromEntries(
        Object.entries(result)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, values]) => [key, Object.freeze([...values].sort())]),
      ),
    );
  };
  const price = (list: SearchParsedAttribute[]) =>
    list.find((item) => item.type === 'price')?.price ?? null;
  const filters: Record<string, unknown> = {};
  const setList = (key: keyof CanonicalMarketFilters, values: string[]) => {
    if (values.length)
      filters[key] = Object.freeze([...limited(values)].sort());
  };
  setList('categoryIds', collect(hard, 'category'));
  setList('categoryTypeIds', collect(hard, 'garmentType'));
  setList('brandIds', collect(hard, 'brand'));
  setList('tags', collect(hard, 'tag'));
  setList('colors', collect(hard, 'color'));
  setList('sizes', collect(hard, 'size'));
  setList('audience', collect(hard, 'audience'));
  const hardDimensions = dimensions(hard);
  if (Object.keys(hardDimensions).length) filters.dimensions = hardDimensions;
  const hardPrice = price(hard);
  if (hardPrice) filters.price = hardPrice;
  const fulfilment = hard.find((item) => item.type === 'fulfilment');
  if (fulfilment) filters.fulfilment = fulfilment.value;
  if (hard.some((item) => item.type === 'onSale')) filters.onSale = true;

  // Residual text: words no hard or implied attribute consumed.
  const groups: string[][] = [];
  const residualWords: string[] = [];
  const corrections = [...input.corrections];
  const understood = attributes.length > 0;
  input.tokens.forEach((token, position) => {
    const kept = !token.used || input.softTokens.has(position);
    if (!kept || !token.key || token.money) return;
    if (understood && FILLER.has(token.word)) return;
    residualWords.push(token.word);
    const alternatives = [token.word, ...(index?.synonyms(token.key) ?? [])];
    // Section 3.3 auto-correct: an unknown word also searches its one clear
    // correction ("dashki" finds "dashiki"); the typed word is kept too.
    const fixed =
      index && !index.isKnown(token.key)
        ? index.correct(token.key, SEARCH_AUTOCORRECT_SIMILARITY)
        : null;
    if (fixed && !fixed.ambiguous) {
      alternatives.push(fixed.word);
      if (!corrections.some((item) => item.from === token.word))
        corrections.push({
          from: token.word,
          to: fixed.word,
          similarity: fixed.similarity,
          applied: false,
        });
    }
    groups.push([...new Set(alternatives)].slice(0, RESIDUAL_ALTERNATIVES));
  });
  if (
    !residualWords.length &&
    !attributes.some(
      (item) =>
        item.applied === 'filter' ||
        item.applied === 'implied' ||
        item.applied === 'overridden',
    )
  ) {
    // Nothing understood and only generic words: search them as typed.
    input.tokens.forEach((token) => {
      if (token.key && !token.money && !token.used) {
        residualWords.push(token.word);
        groups.push([token.word]);
      }
    });
  }
  return Object.freeze({
    normalizedQuery: input.normalizedQuery,
    attributes: Object.freeze(
      attributes.map((item) => Object.freeze({ ...item })),
    ),
    residual: residualWords.join(' '),
    residualGroups: Object.freeze(groups.map((group) => Object.freeze(group))),
    filters: Object.freeze(filters) as CanonicalMarketFilters,
    boosts: Object.freeze({
      categoryIds: limited(collect(soft, 'category')),
      categoryTypeIds: limited(collect(soft, 'garmentType')),
      brandIds: limited(collect(soft, 'brand')),
      tags: limited(collect(soft, 'tag')),
      colors: limited(collect(soft, 'color')),
      sizes: limited(collect(soft, 'size')),
      audience: limited(collect(soft, 'audience')) as readonly MarketAudience[],
      dimensions: dimensions(soft),
      price: price(soft),
    }),
    corrections: Object.freeze(corrections),
    truncated: input.truncated,
    lexiconVersion: index?.version ?? null,
  });
}
