import { EventEmitter } from 'events';
import { EmptyError, firstValueFrom, lastValueFrom, of, Subject } from 'rxjs';
import { UnauthorizedException } from '@nestjs/common';
import { guardReadResponse } from './read-response-boundary';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
};
const lifecycle = () => ({ request: Object.assign(new EventEmitter(), { aborted: false }),
  response: Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false }) });

describe('authenticated read response boundary', () => {
  it('holds private content until the final authorization succeeds', async () => {
    const { request, response } = lifecycle(), check = deferred();
    const next = jest.fn(); const complete = jest.fn();
    guardReadResponse(of({ private: true }), () => check.promise, request, response).subscribe({ next, complete });
    expect(next).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
    check.resolve(); await check.promise; await Promise.resolve();
    expect(next).toHaveBeenCalledWith({ private: true }); expect(complete).toHaveBeenCalledTimes(1);
    expect(request.listenerCount('aborted')).toBe(0); expect(response.listenerCount('close')).toBe(0);
  });
  it('returns denial without a payload when authority changed during the read', async () => {
    const { request, response } = lifecycle(); const next = jest.fn(), error = jest.fn();
    guardReadResponse(of({ financialRecords: ['private'] }), async () => { throw new UnauthorizedException(); }, request, response)
      .subscribe({ next, error });
    await Promise.resolve(); await Promise.resolve();
    expect(next).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
    expect(request.listenerCount('aborted')).toBe(0); expect(response.listenerCount('close')).toBe(0);
  });
  it.each(['aborted', 'close'] as const)('discards a late authorized result as an ended request (409) and removes listeners after %s', async event => {
    const { request, response } = lifecycle(), check = deferred();
    const next = jest.fn(), complete = jest.fn(), error = jest.fn();
    guardReadResponse(of({ private: true }), () => check.promise, request, response).subscribe({ next, complete, error });
    if (event === 'aborted') request.emit(event); else response.emit(event);
    check.resolve(); await check.promise; await Promise.resolve();
    expect(next).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    expect(request.listenerCount('aborted')).toBe(0); expect(response.listenerCount('close')).toBe(0);
  });
  it('never hands Nest an empty stream when the client disconnects mid-read (EmptyError -> 500)', async () => {
    const { request, response } = lifecycle(), check = deferred();
    const pending = lastValueFrom(guardReadResponse(of({ private: true }), () => check.promise, request, response));
    response.emit('close');
    check.resolve();
    await expect(pending).rejects.toMatchObject({ status: 409 });
    await expect(pending).rejects.not.toBeInstanceOf(EmptyError);
  });
  it('does not subscribe a read that was already aborted', async () => {
    const { request, response } = lifecycle(); request.aborted = true;
    const validate = jest.fn();
    await expect(firstValueFrom(guardReadResponse(of('private'), validate, request, response))).rejects.toMatchObject({ status: 409 });
    expect(validate).not.toHaveBeenCalled(); expect(request.listenerCount('aborted')).toBe(0);
  });
  it('unsubscription releases listeners and repeated reads do not accumulate them', async () => {
    const { request, response } = lifecycle(); const source = new Subject<string>(); const validate = jest.fn();
    const subscription = guardReadResponse(source, validate, request, response).subscribe(); subscription.unsubscribe();
    expect(request.listenerCount('aborted')).toBe(0); expect(response.listenerCount('close')).toBe(0);
    for (let i = 0; i < 20; i++) {
      expect(await firstValueFrom(guardReadResponse(of(i), async () => undefined, request, response))).toBe(i);
      expect(request.listenerCount('aborted')).toBe(0); expect(response.listenerCount('close')).toBe(0);
    }
  });
});
