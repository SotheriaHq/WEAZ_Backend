import { Injectable } from '@nestjs/common';

const SEARCH_TOKEN_MIN_LENGTH = 2;

const SEARCH_STOP_WORDS = new Set([
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

const SEARCH_GENERIC_COMMERCE_TERMS = new Set([
  'brand',
  'brands',
  'cloth',
  'clothes',
  'collection',
  'collections',
  'design',
  'designs',
  'fashion',
  'item',
  'items',
  'look',
  'looks',
  'market',
  'piece',
  'pieces',
  'product',
  'products',
  'shop',
  'store',
  'style',
  'wear',
  'wears',
]);

@Injectable()
export class SearchTokenService {
  tokenize(query: string): string[] {
    return query
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  significantTokens(tokens: string[]): string[] {
    return Array.from(
      new Set(
        tokens.filter((token) => token.length >= SEARCH_TOKEN_MIN_LENGTH),
      ),
    );
  }

  importantTokens(tokens: string[]): string[] {
    return this.significantTokens(tokens).filter(
      (token) => !SEARCH_STOP_WORDS.has(token),
    );
  }

  distinctiveTokens(tokens: string[]): string[] {
    const important = this.importantTokens(tokens);
    const distinctive = important.filter(
      (token) => !SEARCH_GENERIC_COMMERCE_TERMS.has(token),
    );
    return distinctive.length > 0 ? distinctive : important;
  }

  commerceGateTokens(tokens: string[]): string[] {
    const distinctive = this.distinctiveTokens(tokens);
    return distinctive.length > 0 ? distinctive : this.importantTokens(tokens);
  }
}
