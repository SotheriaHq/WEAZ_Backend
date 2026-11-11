import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, finalize, tap, type Subscription } from 'rxjs';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { BrandAccessService } from 'src/brands/brand-access.service';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { ADMIN_PERMISSIONS_KEY } from 'src/admin/decorators/require-permissions.decorator';
import { IS_PUBLIC_KEY } from '../decorator/is-public.decorator';
import { ROLES_KEY } from '../decorator/roles.decorator';
import { READ_ONLY_RESPONSE_KEY } from '../decorator/read-only-response.decorator';
import { classifyAdaptiveAction } from './adaptive-action-policy';
import {
  AdaptiveAccessService,
  type AdaptiveOperation,
} from './adaptive-access.service';
import { SessionRiskService } from './session-risk.service';
import {
  createSecurityLease,
  getLiveSecurityContext,
  securityRequestContext,
} from './security-request-context';
import { payoutAccountApprovalState } from './payout-account-approval-state';
import { subscriptionQuoteApprovalState } from 'src/subscriptions/subscription-quotes';
import { savedPaymentMethodApprovalState } from 'src/payment/saved-payment-method-version';
import { guardContentReadResponse } from './content-read-response';
import { lockCurrentSecurityActor } from './security-actor';
import { guardCommandResponse } from './command-response-boundary';

@Injectable()
export class AdaptiveAccessInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly risk: SessionRiskService,
    private readonly access: AdaptiveAccessService,
  ) {}
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const publicMetadata = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()]);
    const requiredAdminPermissions = [...(this.reflector.getAllAndOverride<string[]>(ADMIN_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()]) ?? [])];
    const declaredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY,
      [context.getHandler(), context.getClass()]);
    const requiredRoles = declaredRoles === undefined ? undefined : [...declaredRoles];
    const isPublic = publicMetadata && requiredAdminPermissions.length === 0 && requiredRoles === undefined;
    const request = context.switchToHttp().getRequest();
    const principal = request.user;
    if (!principal && (requiredAdminPermissions.length || requiredRoles !== undefined))
      throw new UnauthorizedException('Sign in to access administrator information');
    const readOnlyResponse = request.method === 'POST' &&
      this.reflector.getAllAndOverride<boolean>(READ_ONLY_RESPONSE_KEY, [context.getHandler(), context.getClass()]) === true;
    const isRead = request.method === 'GET' || request.method === 'HEAD' || readOnlyResponse;
    if (isPublic && !isRead) return next.handle();
    if (!principal) return isRead ? guardContentReadResponse(() => next.handle(), this.prisma,
      async () => undefined, request, context.switchToHttp().getResponse()) : next.handle();
    if (!principal.id || !principal.sid || !principal.securitySession)
      throw new UnauthorizedException('Sign in again to secure this session');
    if (requiredRoles !== undefined && !requiredRoles.includes(principal.role))
      throw new ForbiddenException('The current account role cannot perform this action');
    // A Studio child cannot satisfy a challenge belonging to its phone.
    // Check before even ordinary account mutations or child MFA endpoints.
    if (principal.securitySession.parentSessionId) {
      await this.prisma.$transaction(tx => lockCurrentSecurityActor(tx, {
        id: principal.id, sid: principal.sid, authVersion: principal.authVersion, role: principal.role,
      }));
    }
    const route = String(request.route?.path ?? '');
    const readResponse = (stream: () => Observable<unknown>, policy = classifyAdaptiveAction(request.method, route, request.params,
      { enrolledMfa: false, actorRole: principal.role, adminPermissions: requiredAdminPermissions, requiredRoles })) => {
      const operation = getLiveSecurityContext()?.operation ?? { actor: { id: principal.id, sid: principal.sid, authVersion: principal.authVersion, role: principal.role },
        policy, method: request.method, path: request.originalUrl, route, body: isRead ? null : request.body ?? null,
        readOnlyResponse,
        requiredAdminPermissions, requiredRoles, requestId: randomUUID(), operationDigest: '' };
      operation.operationDigest = this.access.digest(operation);
      if (!isRead) return guardCommandResponse(stream, operation,
        replacement => this.access.revalidateCommand(operation, replacement), request, context.switchToHttp().getResponse());
      return guardContentReadResponse(stream, this.prisma, () => this.access.revalidateRead(operation), request,
        context.switchToHttp().getResponse());
    };
    // Public detail routes can include optional-auth private content. Their
    // domain witnesses and authenticated actor must survive to delivery too.
    if (isPublic) return readResponse(() => next.handle(), { scope: 'SELF', sensitivity: 'ACCOUNT', action: 'account.access' });
    // Bootstrap and challenge verification stay reachable while challenged.
    // Adding another factor requires a new action approval, selected using server state.
    let enrolledMfa = false;
    if (route.startsWith('/auth/security/mfa') && requiredAdminPermissions.length === 0) {
      const begin =
        request.method === 'POST' &&
        /^\/auth\/security\/mfa\/(?:totp|passkeys)\/begin\/?$/.test(route);
      const mutation =
        request.method === 'POST' &&
        (/^\/auth\/security\/mfa\/factors\/:id\/revoke\/?$/.test(route) ||
          /^\/auth\/security\/mfa\/recovery-codes\/regenerate\/?$/.test(route));
      if (!begin && !mutation) return readResponse(() => next.handle());
      if (begin) {
        enrolledMfa = Boolean(
          await this.prisma.securityFactor.findFirst({
            where: {
              userId: principal.id,
              revokedAt: null,
              verifiedAt: { not: null },
            },
            select: { id: true },
          }),
        );
        if (!enrolledMfa) return readResponse(() => next.handle());
      }
    }
    const policy = classifyAdaptiveAction(
      request.method,
      route,
      request.params,
      { enrolledMfa, actorRole: principal.role, adminPermissions: requiredAdminPermissions, requiredRoles },
    );
    if (policy.scope.startsWith('BRAND')) {
      const brands = new BrandAccessService(
        this.prisma,
        new BrandPermissionService(this.prisma),
      );
      policy.brandId = policy.brandId
        ? await brands.resolveBrandIdFromBrandOrOwnerId(policy.brandId)
        : ((await brands.getPrimaryBrandContext(principal.id)).activeBrandId ??
          undefined);
      if (!policy.brandId)
        throw new ForbiddenException('Brand access is required');
    }
    const state = await this.risk.observe(
      principal,
      principal.securitySession,
      {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      },
      policy.sensitivity === 'SENSITIVE_READ',
    );
    const observeDenials = tap({
      error: (error: { getStatus?: () => number }) => {
        if ([401, 403].includes(error.getStatus?.() ?? 0))
          void this.risk.recordDenied(principal).catch(() => undefined);
      },
    });
    if (policy.sensitivity === 'ACCOUNT' && state.state === 'NORMAL')
      return readResponse(() => next.handle(), policy).pipe(observeDenials);
    const candidate = {
      actor: {
        id: principal.id,
        sid: principal.sid,
        authVersion: principal.authVersion,
        role: principal.role,
      },
      policy,
      method: request.method,
      readOnlyResponse,
      path: request.originalUrl,
      route,
      body: request.body ?? null,
      serverState:
        request.method === 'PATCH' &&
        route.replace(/\/$/, '') === '/store/payment-account'
          ? await payoutAccountApprovalState(this.prisma, policy.brandId!)
          : request.method === 'POST' &&
              route.replace(/\/$/, '') ===
                '/brands/:brandId/subscription/checkout'
            ? await subscriptionQuoteApprovalState(
                this.prisma,
                request.body?.quoteId,
                policy.brandId!,
                principal.id,
                request.body?.savedCardId,
              )
            : request.method === 'POST' &&
                route.replace(/\/$/, '') ===
                  '/brands/:brandId/subscription/payment-method'
              ? await savedPaymentMethodApprovalState(
                  this.prisma,
                  principal.id,
                  request.body?.savedCardId,
                )
              : null,
      requiredAdminPermissions,
      requiredRoles,
      proof:
        typeof request.headers['x-wiez-action-proof'] === 'string'
          ? request.headers['x-wiez-action-proof']
          : undefined,
    };
    const operation: AdaptiveOperation = {
      ...candidate,
      requestId: randomUUID(),
      operationDigest: this.access.digest(candidate),
    };
    await this.access.authorize(operation, state);
    return new Observable((subscriber) => {
      const lease = createSecurityLease();
      const response = context.switchToHttp().getResponse();
      let subscription: Subscription | undefined;
      const abort = () => {
        lease.close();
        subscription?.unsubscribe();
        subscriber.complete();
      };
      const close = () => {
        if (!response.writableEnded) abort();
      };
      request.once?.('aborted', abort);
      response.once?.('close', close);
      const cleanup = () => {
        lease.close();
        request.removeListener?.('aborted', abort);
        response.removeListener?.('close', close);
      };
      if (request.aborted || (response.destroyed && !response.writableEnded))
        lease.close();
      try {
        subscription = securityRequestContext.run(
          { operation, request: lease, riskObservation: Object.freeze({ actorId: state.actorId,
            sessionId: state.sessionId, authVersion: state.authVersion, observedAt: state.observedAt }) },
          () => {
            getLiveSecurityContext();
            return readResponse(() => next.handle(), policy)
              .pipe(observeDenials, finalize(cleanup))
              .subscribe(subscriber);
          },
        );
        return () => {
          cleanup();
          subscription?.unsubscribe();
        };
      } catch (error) {
        cleanup();
        throw error;
      }
    });
  }
}
