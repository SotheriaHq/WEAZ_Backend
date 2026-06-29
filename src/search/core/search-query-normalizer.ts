import { Injectable } from '@nestjs/common';

@Injectable()
export class SearchQueryNormalizer {
  normalize(raw?: string | null): string {
    return String(raw || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\u0000/g, '')
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  compactHandle(raw?: string | null): string {
    return this.normalize(raw).replace(/[^\p{L}\p{N}]+/gu, '');
  }
}
