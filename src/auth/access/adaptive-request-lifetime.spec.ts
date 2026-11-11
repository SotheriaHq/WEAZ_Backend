import { EventEmitter } from 'events';
import { Subject } from 'rxjs';
import { AdaptiveAccessInterceptor } from './adaptive-access.interceptor';
import { securityRequestContext } from './security-request-context';

function setup() {
  const request = Object.assign(new EventEmitter(), { aborted: false, method: 'POST',
    route: { path: '/auth/change-password' }, originalUrl: '/auth/change-password', body: {}, headers: {},
    user: { id: 'actor', sid: 'session', authVersion: 1, role: 'User', securitySession: {} } });
  const response = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false });
  const context: any = { getType: () => 'http', getHandler: () => () => {}, getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) };
  const interceptor = new AdaptiveAccessInterceptor({ getAllAndOverride: () => undefined } as any, {} as any,
    { observe: async () => ({ state: 'NORMAL' }), recordDenied: jest.fn() } as any,
    { digest: () => 'fixture-digest', authorize: async () => {}, revalidateCommand: async () => {} } as any);
  const subject = new Subject();
  let captured: ReturnType<typeof securityRequestContext.getStore>;
  const next = { handle: jest.fn(() => { captured = securityRequestContext.getStore(); return subject; }) };
  return { request, response, context, interceptor, subject, next, capture: () => captured };
}

describe('adaptive HTTP request lifetime', () => {
  it('keeps authenticated MFA recovery reachable while challenging an additional enrollment', async () => {
    const recovery = setup();
    recovery.request.route.path = '/auth/security/mfa/challenges/:id/verify';
    const recovered = await recovery.interceptor.intercept(recovery.context, recovery.next);
    const recoverySubscription = recovered.subscribe();
    expect(recovery.next.handle).toHaveBeenCalledTimes(1);
    recoverySubscription.unsubscribe();

    const fixture = setup();
    fixture.request.route.path = '/auth/security/mfa/passkeys/begin';
    const authorize = jest.fn().mockResolvedValue(undefined);
    const factors = { findFirst: jest.fn().mockResolvedValue({ id: 'existing-factor' }) };
    const interceptor = new AdaptiveAccessInterceptor({ getAllAndOverride: () => undefined } as any,
      { securityFactor: factors } as any,
      { observe: async () => ({ state: 'NORMAL' }), recordDenied: jest.fn() } as any,
      { digest: () => 'fixture-digest', authorize, revalidateCommand: async () => {} } as any);
    const stream = await interceptor.intercept(fixture.context, fixture.next);
    const subscription = stream.subscribe();
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ policy: {
      scope: 'SELF', sensitivity: 'CRITICAL_CHANGE', action: 'authentication.factor.add',
    } }), expect.anything());
    expect(fixture.capture()?.request.active).toBe(true);
    subscription.unsubscribe();
    expect(fixture.capture()?.request.active).toBe(false);
  });

  it.each(['complete', 'error', 'unsubscribe', 'aborted', 'close'] as const)('closes authority and removes listeners on %s', async (end) => {
    const fixture = setup();
    const stream = await fixture.interceptor.intercept(fixture.context, fixture.next);
    const subscription = stream.subscribe({ error: () => {} });
    const context = fixture.capture();
    expect(context?.request.active).toBe(true);
    if (end === 'complete') fixture.subject.complete();
    if (end === 'error') fixture.subject.error(new Error('fixture failure'));
    if (end === 'unsubscribe') subscription.unsubscribe();
    if (end === 'aborted') fixture.request.emit('aborted');
    if (end === 'close') fixture.response.emit('close');
    // Completion now includes the asynchronous final actor check, including
    // an EMPTY handler. Its authority lease lasts until that check finishes.
    if (end === 'complete') await new Promise(resolve => setImmediate(resolve));
    expect(context?.request.active).toBe(false);
    expect(subscription.closed).toBe(true);
    expect(fixture.request.listenerCount('aborted')).toBe(0);
    expect(fixture.response.listenerCount('close')).toBe(0);
  });

  it('does not start protected work if the client disconnected before subscription', async () => {
    const fixture = setup(); fixture.request.aborted = true;
    const stream = await fixture.interceptor.intercept(fixture.context, fixture.next);
    const error = jest.fn();
    stream.subscribe({ error });
    expect(fixture.next.handle).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    expect(fixture.request.listenerCount('aborted')).toBe(0);
  });
});
