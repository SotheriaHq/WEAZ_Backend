import { ConflictException } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Observable, concatMap, defaultIfEmpty, finalize, map, take, toArray } from 'rxjs';
import type { AdaptiveOperation } from './adaptive-access.service';
import type { SecurityActor } from './security-actor';
import { guardReadResponse } from './read-response-boundary';

type Completion =
  | { kind: 'PASSWORD_ROTATED'; actor: Readonly<SecurityActor>; finishHeaders: () => void }
  | { kind: 'LOGOUT_ALL' | 'ACCOUNT_DELETED'; finishHeaders?: () => void };
type Scope = { open: boolean; operation: AdaptiveOperation; completion?: Completion };
const commandResponseContext = new AsyncLocalStorage<Scope>();
export function getLiveCommandOperation(): AdaptiveOperation | undefined {
  const scope = commandResponseContext.getStore();
  if (!scope) return undefined;
  if (!scope.open) throw responseWithheld();
  return scope.operation;
}
const sameActor = (left: SecurityActor, right: SecurityActor) => left.id === right.id &&
  left.sid === right.sid && left.authVersion === right.authVersion && left.role === right.role;
export const responseWithheld = () => new ConflictException({ code: 'SECURITY_RESPONSE_WITHHELD',
  message: 'This action may have completed, but your access changed before its response could be delivered. Check its status before trying again.' });

/** Only these server-owned transitions may intentionally end the admitted
 * authority. Register after commit, within the same live HTTP request. */
export function rememberTerminalCommand(kind: 'LOGOUT_ALL' | 'ACCOUNT_DELETED', userId: string, finishHeaders?: () => void): void {
  const scope = commandResponseContext.getStore();
  if (!scope) return;
  const expectedRoute = kind === 'LOGOUT_ALL' ? '/auth/logout-all' : '/auth/account/delete';
  if (!scope.open || scope.completion || scope.operation.actor.id !== userId ||
    scope.operation.method !== 'POST' || scope.operation.route.replace(/\/$/, '') !== expectedRoute)
    throw responseWithheld();
  scope.completion = Object.freeze({ kind, finishHeaders });
}

/** Headers are deliberately delayed until the final replacement-principal
 * check. A failed response gate must not leak credentials through Set-Cookie. */
export function rememberPasswordCommand(original: SecurityActor, replacement: SecurityActor, finishHeaders: () => void): boolean {
  const scope = commandResponseContext.getStore();
  if (!scope) return false;
  if (!scope.open || scope.completion || !sameActor(scope.operation.actor, original) ||
    scope.operation.method !== 'POST' || !/^\/auth\/(?:admin\/)?change-password\/?$/.test(scope.operation.route) ||
    replacement.id !== original.id || replacement.sid !== original.sid || replacement.role !== original.role ||
    replacement.authVersion !== original.authVersion + 1)
    throw responseWithheld();
  scope.completion = Object.freeze({ kind: 'PASSWORD_ROTATED', actor: Object.freeze({ ...replacement }), finishHeaders });
  return true;
}

/** Authenticated command handlers are finite JSON/204 responses, not SSE.
 * Buffer their single result until completion, including EMPTY/204. Never
 * resubscribe, rerun a handler, mint a challenge, or replay its side effects. */
export function guardCommandResponse<T>(source: () => Observable<T>, operation: AdaptiveOperation,
  validate: (replacement?: Readonly<SecurityActor>) => Promise<void>,
  request: Parameters<typeof guardReadResponse>[2], response: Parameters<typeof guardReadResponse>[3]): Observable<unknown> {
  return new Observable(subscriber => {
    const scope: Scope = { open: true, operation };
    const close = () => { scope.open = false; scope.completion = undefined; };
    try {
      return commandResponseContext.run(scope, () => {
        const finite = source().pipe(take(2), toArray(), concatMap(async values => {
          if (values.length > 1) throw responseWithheld();
          const completion = scope.completion;
          if (completion?.kind === 'LOGOUT_ALL') return { message: 'Logged out from all devices' };
          if (completion?.kind === 'ACCOUNT_DELETED') return { message: 'Your account has been deleted.' };
          return values[0];
        }), defaultIfEmpty(undefined));
        return guardReadResponse(finite, async () => {
          try {
            if (!scope.open) throw responseWithheld();
            if (scope.completion?.kind === 'PASSWORD_ROTATED') {
              await validate(scope.completion.actor);
              if (!scope.open) throw responseWithheld();
              scope.completion.finishHeaders();
            } else if (scope.completion) scope.completion.finishHeaders?.();
            else await validate();
          } catch { throw responseWithheld(); }
        }, request, response).pipe(map(value => value), finalize(close)).subscribe(subscriber);
      });
    } catch (error) { close(); throw error; }
  });
}
