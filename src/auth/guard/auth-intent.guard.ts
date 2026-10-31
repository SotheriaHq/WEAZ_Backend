import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorator/is-public.decorator';
import { AuthGuard } from '@nestjs/passport';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';

// NestJS stores the guards registered by @UseGuards() under this metadata key.
// Hard-coded (instead of importing from '@nestjs/common/constants') to avoid
// depending on an internal module path.
const GUARDS_METADATA = '__guards__';

/**
 * Fail-closed default-auth guard (bound globally as an APP_GUARD).
 *
 * Previously auth was fail-OPEN: a handler with no `@UseGuards(...)` was
 * silently unauthenticated. This guard flips the default to fail-closed while
 * keeping the blast radius minimal:
 *
 *  - `@IsPublic()` handlers/classes are always allowed.
 *  - Handlers/classes that declare a recognised authentication guard
 *    (including `OptionalJwtAuthGuard` used by public storefront reads) are
 *    allowed through — their own guard performs whatever auth it intends, so
 *    this guard never double-enforces or blocks anonymous-allowed routes.
 *  - A handler with NO explicit auth intent at all (no guard, not `@IsPublic`)
 *    is rejected, so a forgotten `@UseGuards` can no longer expose an endpoint.
 */
@Injectable()
export class AuthIntentGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Only guard HTTP handlers; let non-HTTP contexts (ws/rpc) pass.
    if (context.getType() !== 'http') {
      return true;
    }

    const handler = context.getHandler();
    const cls = context.getClass();

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      handler,
      cls,
    ]);
    if (isPublic) {
      return true;
    }

    if (
      this.hasAuthenticationGuard(handler) ||
      this.hasAuthenticationGuard(cls)
    ) {
      return true;
    }

    throw new UnauthorizedException('Authentication required');
  }

  private hasAuthenticationGuard(target: unknown): boolean {
    const guards = Reflect.getMetadata(GUARDS_METADATA, target as object) as
      | unknown[]
      | undefined;
    const authenticationGuards: readonly unknown[] = [
      JwtAuthGuard,
      OptionalJwtAuthGuard,
      AuthGuard('jwt'),
    ];
    return (
      Array.isArray(guards) &&
      guards.some((guard) => authenticationGuards.includes(guard))
    );
  }
}
