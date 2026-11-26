import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PipelineSource } from './market-pipeline.types';
import { Prisma } from '@prisma/client';

export type PipelineSectionKey = readonly (string | number)[];
export interface PipelineSectionCursor {
  readonly v: 1;
  readonly namespace: string;
  readonly binding: string;
  readonly sourceHash: string;
  readonly revision: string;
  readonly asOf: number;
  readonly expiresAt: number;
  readonly key: PipelineSectionKey;
}
const domain = 'market-source-page:v1\n';
const invalid = (): never => {
  throw new BadRequestException({
    code: 'INVALID_CURSOR',
    message: 'Refresh this list to continue.',
  });
};
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Source-order cursors cannot be replayed as catalogue/price cursors. */
export class PipelineSectionCursorCodec {
  constructor(
    private readonly secret: string,
    private readonly namespace: string,
    private readonly previous?: string,
  ) {
    if (
      Buffer.byteLength(secret) < 32 ||
      secret.length > 4096 ||
      !uuid.test(namespace) ||
      (previous !== undefined &&
        (Buffer.byteLength(previous) < 32 || previous.length > 4096))
    )
      throw new ServiceUnavailableException({
        code: 'CATALOGUE_CURSOR_UNAVAILABLE',
        message: 'The catalogue is updating. Please try again shortly.',
      });
  }
  binding(value: unknown): string {
    return createHash('sha256')
      .update(domain + 'binding\n' + JSON.stringify(value))
      .digest('hex');
  }
  encode(value: PipelineSectionCursor): string {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return (
      body +
      '.' +
      createHmac('sha256', this.secret)
        .update(domain + body)
        .digest('base64url')
    );
  }
  authenticate(token: string): PipelineSectionCursor {
    if (
      typeof token !== 'string' ||
      token.length > 4096 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)
    )
      invalid();
    const [body, signature] = token.split('.');
    const supplied = Buffer.from(signature, 'base64url');
    const valid = [this.secret, ...(this.previous ? [this.previous] : [])].some(
      (secret) => {
        const expected = createHmac('sha256', secret)
          .update(domain + body)
          .digest();
        return (
          expected.length === supplied.length &&
          timingSafeEqual(expected, supplied)
        );
      },
    );
    if (!valid) invalid();
    let state: unknown;
    try {
      state = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      invalid();
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) invalid();
    const value = state as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(',') !==
        'asOf,binding,expiresAt,key,namespace,revision,sourceHash,v' ||
      value.v !== 1 ||
      typeof value.namespace !== 'string' ||
      !uuid.test(value.namespace) ||
      typeof value.binding !== 'string' ||
      !hash.test(value.binding) ||
      typeof value.sourceHash !== 'string' ||
      !hash.test(value.sourceHash) ||
      typeof value.revision !== 'string' ||
      !/^[0-9:.-]{1,160}$/.test(value.revision) ||
      !Number.isSafeInteger(value.asOf) ||
      !Number.isSafeInteger(value.expiresAt) ||
      Number(value.asOf) < 0 ||
      Number(value.expiresAt) <= Number(value.asOf) ||
      Number(value.expiresAt) - Number(value.asOf) > 21600000 ||
      !Array.isArray(value.key) ||
      value.key.length < 2 ||
      value.key.length > 4 ||
      value.key.some((item) =>
        typeof item === 'number'
          ? !Number.isFinite(item)
          : typeof item !== 'string' || item.length > 48,
      ) ||
      typeof value.key[value.key.length - 1] !== 'string' ||
      !uuid.test(value.key[value.key.length - 1] as string)
    )
      invalid();
    return value as unknown as PipelineSectionCursor;
  }
  decode(token: string, binding: string, revision: string, now: number) {
    const value = this.authenticate(token);
    if (value.binding !== binding || value.asOf > now + 30000) invalid();
    if (
      value.namespace !== this.namespace ||
      value.expiresAt <= now ||
      value.revision !== revision
    )
      return { kind: 'reanchor' as const };
    return { kind: 'valid' as const, cursor: value };
  }
  state(
    input: Omit<PipelineSectionCursor, 'v' | 'namespace'>,
  ): PipelineSectionCursor {
    return { v: 1, namespace: this.namespace, ...input };
  }
}

type KeyTerm = { type: 'number' | 'date' | 'id'; direction: 'ASC' | 'DESC' };
export function pipelineSourceKeyTerms(
  source: PipelineSource,
): readonly KeyTerm[] {
  switch (source.kind) {
    case 'low_stock':
      return [
        { type: 'number', direction: 'ASC' },
        { type: 'id', direction: 'ASC' },
      ];
    case 'similar':
      return [
        { type: 'number', direction: 'DESC' },
        { type: 'date', direction: 'DESC' },
        { type: 'id', direction: 'ASC' },
      ];
    case 'curated':
    case 'complements':
    case 'category_tiles':
    case 'new_designers':
      return [
        { type: 'number', direction: 'ASC' },
        { type: 'date', direction: 'DESC' },
        { type: 'id', direction: 'ASC' },
      ];
    case 'looks':
      return [
        { type: 'number', direction: 'ASC' },
        { type: 'number', direction: 'DESC' },
        { type: 'date', direction: 'DESC' },
        { type: 'id', direction: 'ASC' },
      ];
    case 'from_runway':
    case 'catalog':
      return [
        { type: 'date', direction: 'DESC' },
        { type: 'id', direction: 'DESC' },
      ];
  }
}
const termsSql = (
  source: PipelineSource,
  alias: 'selected' | 'page' = 'selected',
) =>
  pipelineSourceKeyTerms(source).map((term, index) => ({
    ...term,
    sql:
      term.type === 'number'
        ? alias === 'page'
          ? Prisma.sql`(page."orderKey"->>${index}::int)::numeric`
          : Prisma.sql`(selected."orderKey"->>${index}::int)::numeric`
        : term.type === 'date'
          ? alias === 'page'
            ? Prisma.sql`(page."orderKey"->>${index}::int)::timestamptz`
            : Prisma.sql`(selected."orderKey"->>${index}::int)::timestamptz`
          : alias === 'page'
            ? Prisma.sql`(page."orderKey"->>${index}::int)::uuid`
            : Prisma.sql`(selected."orderKey"->>${index}::int)::uuid`,
  }));
export function validatePipelineSourceKey(
  source: PipelineSource,
  key: PipelineSectionKey,
): void {
  const terms = pipelineSourceKeyTerms(source);
  if (
    key.length !== terms.length ||
    terms.some((term, index) =>
      term.type === 'number'
        ? typeof key[index] !== 'number' || !Number.isFinite(key[index])
        : term.type === 'id'
          ? typeof key[index] !== 'string' || !uuid.test(key[index] as string)
          : typeof key[index] !== 'string' ||
            !Number.isFinite(Date.parse(key[index] as string)),
    )
  )
    invalid();
}
export function pipelineSourceKeyOrderSql(
  source: PipelineSource,
  alias: 'selected' | 'page' = 'selected',
): Prisma.Sql {
  if (!['selected', 'page'].includes(alias))
    throw new RangeError('Invalid source key alias');
  return Prisma.join(
    termsSql(source, alias).map((term) =>
      term.direction === 'ASC'
        ? Prisma.sql`${term.sql} ASC`
        : Prisma.sql`${term.sql} DESC`,
    ),
    ',',
  );
}
export function pipelineSourceKeyAfterSql(
  source: PipelineSource,
  key?: PipelineSectionKey,
): Prisma.Sql {
  if (!key) return Prisma.sql`true`;
  validatePipelineSourceKey(source, key);
  const terms = termsSql(source);
  const cast = (index: number) =>
    terms[index].type === 'number'
      ? Prisma.sql`${key[index]}::numeric`
      : terms[index].type === 'date'
        ? Prisma.sql`${key[index]}::timestamptz`
        : Prisma.sql`${key[index]}::uuid`;
  return Prisma.sql`(${Prisma.join(
    terms.map(
      (term, index) =>
        Prisma.sql`(${Prisma.join([...terms.slice(0, index).map((prior, j) => Prisma.sql`${prior.sql}=${cast(j)}`), term.direction === 'ASC' ? Prisma.sql`${term.sql}>${cast(index)}` : Prisma.sql`${term.sql}<${cast(index)}`], ' AND ')})`,
    ),
    ' OR ',
  )})`;
}

/** Closed server expressions let the source apply seeking before its own LIMIT. */
export function pipelineNativeKeyAfterSql(
  source: PipelineSource,
  expressions: readonly Prisma.Sql[],
  key?: PipelineSectionKey,
): Prisma.Sql {
  if (!key) return Prisma.sql`true`;
  validatePipelineSourceKey(source, key);
  const terms = pipelineSourceKeyTerms(source);
  if (expressions.length !== terms.length)
    throw new RangeError('Invalid native source key');
  const cast = (index: number) =>
    terms[index].type === 'number'
      ? Prisma.sql`${key[index]}::numeric`
      : terms[index].type === 'date'
        ? Prisma.sql`${key[index]}::timestamptz`
        : Prisma.sql`${key[index]}::uuid`;
  return Prisma.sql`(${Prisma.join(
    terms.map(
      (term, index) =>
        Prisma.sql`(${Prisma.join([...terms.slice(0, index).map((_, j) => Prisma.sql`${expressions[j]}=${cast(j)}`), term.direction === 'ASC' ? Prisma.sql`${expressions[index]}>${cast(index)}` : Prisma.sql`${expressions[index]}<${cast(index)}`], ' AND ')})`,
    ),
    ' OR ',
  )})`;
}
export function pipelineNativeKeyOrderSql(
  source: PipelineSource,
  expressions: readonly Prisma.Sql[],
): Prisma.Sql {
  const terms = pipelineSourceKeyTerms(source);
  if (expressions.length !== terms.length)
    throw new RangeError('Invalid native source key');
  return Prisma.join(
    terms.map((term, index) =>
      term.direction === 'ASC'
        ? Prisma.sql`${expressions[index]} ASC`
        : Prisma.sql`${expressions[index]} DESC`,
    ),
    ',',
  );
}

/** Version is a change detector only. Live eligibility/suppression remains SQL authority. */
export function pipelineSourceRevisionSql(): Prisma.Sql {
  return Prisma.sql`count(*)::text||':'||COALESCE(sum(hashtextextended(id||':'||"orderKey"::text,0)),0)::text||':'||COALESCE(sum(hashtextextended(id||':'||"orderKey"::text,1)),0)::text`;
}
export function pipelineSectionIdentityHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
