import {
  ConflictException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthController } from './auth.controller';

/**
 * WP-02 (Wave 0, W0-03): POST /auth/refresh used to clear both session
 * cookies on ANY failure. A 503 (session store briefly unreachable) or a 409
 * (another tab rotated the token first and already set fresh cookies) then
 * left the browser without a refresh cookie, so the next refresh was a 401
 * "Refresh token not found" and the person was signed out by a temporary
 * fault. Only a confirmed rejection may end the session.
 */
describe('POST /auth/refresh: only a confirmed rejection ends the session (WP-02)', () => {
  function setup(outcome: () => Promise<unknown>, cookies: Record<string, string> = { refreshToken: 'session.secret' }) {
    const tokenService = { refreshToken: jest.fn(outcome) };
    const config = { get: jest.fn((_key: string, fallback?: string) => fallback) };
    const controller = new AuthController(
      {} as any,
      tokenService as any,
      config as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const res = {
      req: { secure: false, headers: {} },
      clearCookie: jest.fn(),
      setHeader: jest.fn(),
    } as any;
    const req = { cookies, headers: {} } as any;
    return { controller, tokenService, res, req };
  }

  const rejectionOf = (work: Promise<unknown>) =>
    work.then(
      () => {
        throw new Error('expected the refresh to be rejected');
      },
      (error: unknown) => error as HttpException,
    );
  const body = (error: HttpException) => error.getResponse() as Record<string, unknown>;

  it('a confirmed rejection (401) clears both cookies and carries a stable code, message unchanged', async () => {
    const { controller, res, req } = setup(() =>
      Promise.reject(new UnauthorizedException('Invalid refresh token')),
    );
    const error = await rejectionOf(controller.refresh(req, undefined, res));
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(body(error)).toMatchObject({ message: 'Invalid refresh token', code: 'AUTH_REFRESH_INVALID' });
    expect(res.clearCookie.mock.calls.map(([name]) => name).sort()).toEqual(['accessToken', 'refreshToken']);
  });

  it('keeps a more specific code already set by the token service', async () => {
    const { controller, res, req } = setup(() =>
      Promise.reject(
        new UnauthorizedException({
          message: 'Account security changed. Please sign in again.',
          code: 'AUTH_REAUTH_REQUIRED',
        }),
      ),
    );
    const error = await rejectionOf(controller.refresh(req, undefined, res));
    expect(body(error).code).toBe('AUTH_REAUTH_REQUIRED');
    expect(res.clearCookie).toHaveBeenCalledTimes(2);
  });

  it('a temporary failure (503) keeps both cookies and asks the client to retry', async () => {
    const { controller, res, req } = setup(() =>
      Promise.reject(new ServiceUnavailableException('Session could not be renewed. Please retry.')),
    );
    const error = await rejectionOf(controller.refresh(req, undefined, res));
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(body(error)).toMatchObject({
      message: 'Session could not be renewed. Please retry.',
      code: 'SESSION_RENEWAL_UNAVAILABLE',
    });
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it('a concurrent rotation (409 REFRESH_ROTATED) keeps the cookies the winning request set', async () => {
    const rotated = new ConflictException({
      code: 'REFRESH_ROTATED',
      message: 'This refresh was already consumed. Retry with the current session.',
    });
    const { controller, res, req } = setup(() => Promise.reject(rotated));
    const error = await rejectionOf(controller.refresh(req, undefined, res));
    expect(error).toBe(rotated);
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it('an unexpected error is not treated as a rejection', async () => {
    const failure = new Error('connection reset');
    const { controller, res, req } = setup(() => Promise.reject(failure));
    await expect(controller.refresh(req, undefined, res)).rejects.toBe(failure);
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it('a missing refresh token is still a rejection: cookies cleared, coded 401', async () => {
    const { controller, tokenService, res, req } = setup(() => Promise.resolve({}), {});
    const error = await rejectionOf(controller.refresh(req, undefined, res));
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(body(error)).toMatchObject({ message: 'Refresh token not found', code: 'AUTH_REFRESH_INVALID' });
    expect(res.clearCookie).toHaveBeenCalledTimes(2);
    expect(tokenService.refreshToken).not.toHaveBeenCalled();
  });

  it('a successful refresh returns the tokens and touches no cookie here', async () => {
    const { controller, res, req } = setup(() => Promise.resolve({ accessToken: 'a' }));
    await expect(controller.refresh(req, undefined, res)).resolves.toEqual({ accessToken: 'a' });
    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
