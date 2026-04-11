import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from, of } from 'rxjs';
import { catchError, map, mergeMap } from 'rxjs/operators';
import { throwError } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const MAX_KEY_LEN = 200;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest<any>();
    const res = context.switchToHttp().getResponse<any>();

    const userId: string | undefined = req.user?.id;
    if (!userId) {
      // Only support authenticated idempotency for now.
      return next.handle();
    }

    const rawKey =
      (typeof req.headers['idempotency-key'] === 'string'
        ? req.headers['idempotency-key']
        : undefined) ??
      (typeof req.headers['x-idempotency-key'] === 'string'
        ? req.headers['x-idempotency-key']
        : undefined);

    if (!rawKey) return next.handle();

    const key = String(rawKey).trim();
    if (!key || key.length > MAX_KEY_LEN) {
      throw new BadRequestException('Invalid Idempotency-Key');
    }

    const method = String(req.method || 'POST').toUpperCase();
    const path = String(req.route?.path || req.path || req.originalUrl || '');

    const requestHash = createHash('sha256')
      .update(stableStringify({ body: req.body ?? null }))
      .digest('hex');

    const now = Date.now();
    const expiresAt = new Date(now + DEFAULT_TTL_MS);

    const idempotencyKeyModel = (this.prisma as any)['idempotencyKey'];
    if (!idempotencyKeyModel) {
      throw new InternalServerErrorException(
        'Prisma model delegate "idempotencyKey" is not available on PrismaService (ensure the Prisma schema includes it and run prisma generate).',
      );
    }

    return from(
      idempotencyKeyModel
        .findUnique({ where: { userId_key_method_path: { userId, key, method, path } } })
        .then(async (existing: any) => {
          if (existing) {
            if (existing.requestHash !== requestHash) {
              throw new ConflictException(
                'Idempotency-Key reuse with different request payload',
              );
            }

            if (typeof existing.statusCode === 'number') {
              res.setHeader('x-idempotent-replay', 'true');
              res.status(existing.statusCode);
              return { replay: true, body: existing.responseBody };
            }

            // In-flight request with same key; best-effort: treat as conflict.
            throw new ConflictException('Request with this Idempotency-Key is in progress');
          }

          try {
            await idempotencyKeyModel.create({
              data: {
                id: uuidv4(),
                userId,
                key,
                method,
                path,
                requestHash,
                expiresAt,
              },
            });
          } catch {
            // Race: another request created it first.
            const raced = await idempotencyKeyModel.findUnique({
              where: { userId_key_method_path: { userId, key, method, path } },
            });
            if (typeof raced?.statusCode === 'number') {
              res.setHeader('x-idempotent-replay', 'true');
              res.status(raced.statusCode);
              return { replay: true, body: raced.responseBody };
            }
            throw new ConflictException('Request with this Idempotency-Key is in progress');
          }

          // Opportunistic cleanup (1% of calls)
          if (Math.random() < 0.01) {
            void idempotencyKeyModel.deleteMany({ where: { expiresAt: { lt: new Date() } } });
          }

          return { replay: false };
        }),
    ).pipe(
      mergeMap((state: any) => {
        if (state?.replay) {
          return of(state.body);
        }

        return next.handle().pipe(
          mergeMap((body) => {
            const statusCode = res.statusCode;
            return from(
              idempotencyKeyModel
                .update({
                  where: { userId_key_method_path: { userId, key, method, path } },
                  data: { responseBody: body, statusCode },
                })
                .catch(async (persistErr: unknown) => {
                  // If we cannot persist the final response, remove the pending key so
                  // callers can safely retry instead of getting stuck on "in progress".
                  await idempotencyKeyModel
                    .deleteMany({ where: { userId, key, method, path } })
                    .catch((cleanupErr: unknown) => {
                      console.error(
                        '[IdempotencyInterceptor] Failed to clean up key after persist error:',
                        cleanupErr,
                      );
                    });
                  console.error(
                    '[IdempotencyInterceptor] Failed to persist idempotent response:',
                    persistErr,
                  );
                }),
            ).pipe(map(() => body));
          }),
          catchError((err) => {
            // On error: delete the idempotency key record so the caller can
            // retry with the same key. We do NOT persist error responses because
            // a transient failure (Paystack timeout, network blip, validation error)
            // should be retryable with the same idempotency key — not permanently
            // cached as a failure for 24 hours.
            //
            // If the delete itself fails, the key will expire naturally after TTL.
            // We use void + .catch() to not block the error response.
            void idempotencyKeyModel
              .deleteMany({
                where: { userId, key, method, path },
              })
              .catch((deleteErr: unknown) => {
                console.error(
                  '[IdempotencyInterceptor] Failed to clean up key after error:',
                  deleteErr,
                );
              });
            return throwError(() => err);
          }),
        );
      }),
    );
  }
}
