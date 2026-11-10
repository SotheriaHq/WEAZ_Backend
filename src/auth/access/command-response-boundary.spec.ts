import { EventEmitter } from 'node:events';
import { EMPTY, Subject, firstValueFrom, of, throwError } from 'rxjs';
import { UnauthorizedException } from '@nestjs/common';
import { guardCommandResponse, rememberPasswordCommand, rememberTerminalCommand } from './command-response-boundary';
import type { AdaptiveOperation } from './adaptive-access.service';

const actor = { id: 'user', sid: 'session', role: 'User', authVersion: 3 };
const operation = (route = '/account/preferences'): AdaptiveOperation => ({
  actor, policy: { scope: 'SELF', sensitivity: 'ACCOUNT', action: 'account.access' },
  method: 'POST', path: route, route, body: {}, requiredAdminPermissions: [],
  operationDigest: 'exact-command', requestId: 'request-one',
});
const events = () => ({ request: new EventEmitter(), response: new EventEmitter() });

describe('finite authenticated command completion', () => {
  it('withholds a private command body after revocation without a replayable401 or428', async () => {
    const { request, response } = events(); let effects = 0;
    const validate = jest.fn(async () => { throw new UnauthorizedException(); });
    await expect(firstValueFrom(guardCommandResponse(() => { effects++; return of({ private: 'secret' }); },
      operation(), validate, request, response))).rejects.toMatchObject({
        response: { code: 'SECURITY_RESPONSE_WITHHELD' }, status: 409,
      });
    expect(effects).toBe(1); expect(validate).toHaveBeenCalledTimes(1);
    expect(request.listenerCount('aborted')).toBe(0); expect(response.listenerCount('close')).toBe(0);
  });
  it('checks an EMPTY/204 handler and buffers a value until its handler completes', async () => {
    const { request, response } = events(); const validate = jest.fn(async () => undefined);
    expect(await firstValueFrom(guardCommandResponse(() => EMPTY, operation(), validate, request, response))).toBeUndefined();
    expect(validate).toHaveBeenCalledTimes(1);
    const source = new Subject();
    const result = firstValueFrom(guardCommandResponse(() => source, operation(), validate, request, response));
    source.next({ result: true }); expect(validate).toHaveBeenCalledTimes(1);
    source.complete(); expect(await result).toEqual({ result: true }); expect(validate).toHaveBeenCalledTimes(2);
  });
  it.each(['LOGOUT_ALL', 'ACCOUNT_DELETED'] as const)('projects only the fixed %s acknowledgement after its own committed transition', async kind => {
    const { request, response } = events(); const validate = jest.fn(async () => { throw new UnauthorizedException(); });
    const op = operation(kind === 'LOGOUT_ALL' ? '/auth/logout-all' : '/auth/account/delete');
    const result = await firstValueFrom(guardCommandResponse(() => {
      rememberTerminalCommand(kind, actor.id);
      return of({ message: 'untrusted', token: 'must-not-escape', nested: { private: true } });
    }, op, validate, request, response));
    expect(result).toEqual({ message: kind === 'LOGOUT_ALL' ? 'Logged out from all devices' : 'Your account has been deleted.' });
    expect(validate).not.toHaveBeenCalled();
  });
  it('cannot register a terminal receipt for another actor or route, or deliver one from an errored handler', async () => {
    const { request, response } = events();
    await expect(firstValueFrom(guardCommandResponse(() => {
      rememberTerminalCommand('LOGOUT_ALL', actor.id); return of({});
    }, operation(), async () => undefined, request, response))).rejects.toMatchObject({ status: 409 });
    await expect(firstValueFrom(guardCommandResponse(() => {
      rememberTerminalCommand('LOGOUT_ALL', 'another-user'); return of({});
    }, operation('/auth/logout-all'), async () => undefined, request, response))).rejects.toMatchObject({ status: 409 });
    await expect(firstValueFrom(guardCommandResponse(() => {
      rememberTerminalCommand('LOGOUT_ALL', actor.id); return throwError(() => new Error('rollback'));
    }, operation('/auth/logout-all'), async () => undefined, request, response))).rejects.toThrow('rollback');
  });
  it('delays terminal cookie clearing until completion and never clears from an errored handler', async () => {
    const { request, response } = events();
    const headers = jest.fn();
    await expect(firstValueFrom(guardCommandResponse(() => {
      rememberTerminalCommand('LOGOUT_ALL', actor.id, headers);
      expect(headers).not.toHaveBeenCalled();
      return throwError(() => new Error('failed after mutation'));
    }, operation('/auth/logout-all'), async () => undefined, request, response))).rejects.toThrow('failed after mutation');
    expect(headers).not.toHaveBeenCalled();
    await firstValueFrom(guardCommandResponse(() => {
      rememberTerminalCommand('LOGOUT_ALL', actor.id, headers);
      expect(headers).not.toHaveBeenCalled(); return of({});
    }, operation('/auth/logout-all'), async () => undefined, request, response));
    expect(headers).toHaveBeenCalledTimes(1);
  });
  it('checks the exact password replacement before writing any cookies', async () => {
    const { request, response } = events(); const replacement = { ...actor, authVersion: 4 };
    const finishHeaders = jest.fn(), validate = jest.fn(async () => undefined);
    expect(await firstValueFrom(guardCommandResponse(() => {
      expect(rememberPasswordCommand(actor, replacement, finishHeaders)).toBe(true);
      expect(finishHeaders).not.toHaveBeenCalled(); return of({ accessToken: 'replacement' });
    }, operation('/auth/change-password'), validate, request, response))).toEqual({ accessToken: 'replacement' });
    expect(validate).toHaveBeenCalledWith(replacement); expect(finishHeaders).toHaveBeenCalledTimes(1);
    finishHeaders.mockClear();
    await expect(firstValueFrom(guardCommandResponse(() => {
      rememberPasswordCommand(actor, replacement, finishHeaders); return of({ accessToken: 'replacement' });
    }, operation('/auth/admin/change-password'), async () => { throw new UnauthorizedException(); }, request, response)))
      .rejects.toMatchObject({ response: { code: 'SECURITY_RESPONSE_WITHHELD' }, status: 409 });
    expect(finishHeaders).not.toHaveBeenCalled();
  });
  it('does not share completion receipts between requests and rejects multiple bodies', async () => {
    const { request, response } = events();
    await expect(firstValueFrom(guardCommandResponse(() => of({}, {}), operation(), async () => undefined, request, response)))
      .rejects.toMatchObject({ status: 409 });
    const validate = jest.fn(async () => undefined);
    expect(await firstValueFrom(guardCommandResponse(() => of({ private: 'ordinary' }), operation(), validate, request, response)))
      .toEqual({ private: 'ordinary' });
    expect(validate).toHaveBeenCalledWith();
  });
});
