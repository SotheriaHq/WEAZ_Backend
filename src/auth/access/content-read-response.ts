import { Observable, finalize } from 'rxjs';
import type { PrismaService } from 'src/prisma/prisma.service';
import { assertCurrentReadContent } from 'src/common/read-content-access';
import { readResourceContext, type ReadResourceScope } from './read-resource-context';
import { guardReadResponse } from './read-response-boundary';

export function guardContentReadResponse<T>(source: () => Observable<T>, prisma: PrismaService,
  validateActor: () => Promise<void>, request: Parameters<typeof guardReadResponse>[2] & { user?: { id?: string; role?: string } },
  response: Parameters<typeof guardReadResponse>[3]): Observable<T> {
  return new Observable(subscriber => {
    const scope: ReadResourceScope = { open: true, resources: new Map(), actor: request.user?.id
      ? Object.freeze({ id: request.user.id, role: request.user.role }) : undefined };
    const close = () => { scope.open = false; scope.resources.clear(); scope.actor = undefined; };
    try {
      // Nest binds CallHandler.handle() with AsyncResource at creation time.
      // Create its observable inside this scope, not merely its subscription.
      return readResourceContext.run(scope, () => guardReadResponse(source(), async () => {
        await assertCurrentReadContent(prisma, [...scope.resources.values()]);
        // Actor/parent/grants are checked last, after resource database waits.
        await validateActor();
      }, request, response).pipe(finalize(close)).subscribe(subscriber));
    } catch (error) { close(); throw error; }
  });
}
