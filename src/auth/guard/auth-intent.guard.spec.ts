import 'reflect-metadata';
import {
  ExecutionContext,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ThrottlerGuard } from '@nestjs/throttler';
import { IsPublic } from '../decorator/is-public.decorator';
import { AuthIntentGuard } from './auth-intent.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { RolesGuard } from './role.guard';

describe('Auth intent must represent authentication', () => {
  const guard = new AuthIntentGuard(new Reflector());
  const contextFor = (cls: object) =>
    ({
      getType: () => 'http',
      getClass: () => cls,
      getHandler: () => () => {},
    }) as unknown as ExecutionContext;

  it.each([
    ThrottlerGuard,
    RolesGuard,
    class JwtAuthGuard {},
    class OtherGuard {},
  ])('rejects non-authentication guard %p, regardless of its name', (other) => {
    class Controller {}
    UseGuards(other)(Controller);
    expect(() => guard.canActivate(contextFor(Controller))).toThrow(
      UnauthorizedException,
    );
  });

  it.each([JwtAuthGuard, OptionalJwtAuthGuard, AuthGuard('jwt')])(
    'recognises the actual supported authentication guard %p',
    (auth) => {
      class Controller {}
      UseGuards(auth)(Controller);
      expect(guard.canActivate(contextFor(Controller))).toBe(true);
    },
  );

  it('keeps explicitly public routes reachable', () => {
    class Controller {}
    IsPublic()(Controller);
    expect(guard.canActivate(contextFor(Controller))).toBe(true);
  });

  it('cannot disable default-deny authentication through an environment flag', () => {
    const before = process.env.AUTH_FAIL_CLOSED;
    process.env.AUTH_FAIL_CLOSED = 'false';
    try {
      expect(() => guard.canActivate(contextFor(class Controller {}))).toThrow(
        UnauthorizedException,
      );
    } finally {
      if (before === undefined) delete process.env.AUTH_FAIL_CLOSED;
      else process.env.AUTH_FAIL_CLOSED = before;
    }
  });
});
