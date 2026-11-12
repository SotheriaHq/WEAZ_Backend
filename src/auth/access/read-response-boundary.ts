import { ConflictException } from '@nestjs/common';
import { defer, mergeMap, Observable, takeUntil } from 'rxjs';

type Events = {
  once?: (event: string, listener: () => void) => unknown;
  removeListener?: (event: string, listener: () => void) => unknown;
};
type ReadRequest = Events & { aborted?: boolean };
type ReadResponse = Events & { destroyed?: boolean; writableEnded?: boolean };

/** Current authenticated HTTP read handlers return one JSON/buffer body, not
 * SSE. Validate that body before delivery; never keep an authorization lease
 * after disconnect. Streaming event authorization belongs at each event send. */
export function guardReadResponse<T>(source: Observable<T>, validate: () => Promise<void>,
  request: ReadRequest, response: ReadResponse): Observable<T> {
  const ended = () => request.aborted || (response.destroyed && !response.writableEnded);
  // A disconnect must END the stream with an error, not complete it empty: Nest
  // reads the handler with lastValueFrom(), and an empty completion surfaces as
  // EmptyError, i.e. a 500 + Sentry alert for every abandoned page load. The
  // payload is still never delivered; takeUntil forwards this error.
  const stop = new Observable<void>(subscriber => {
    const abort = () => subscriber.error(new ConflictException('This request ended. Start it again.'));
    const close = () => { if (!response.writableEnded) abort(); };
    request.once?.('aborted', abort);
    response.once?.('close', close);
    return () => {
      request.removeListener?.('aborted', abort);
      response.removeListener?.('close', close);
    };
  });
  return defer(() => {
    if (ended()) throw new ConflictException('This request ended. Start it again.');
    return source.pipe(mergeMap(async value => {
      if (ended()) throw new ConflictException('This request ended. Start it again.');
      await validate();
      if (ended()) throw new ConflictException('This request ended. Start it again.');
      return value;
    }, 1), takeUntil(stop));
  });
}
