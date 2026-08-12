import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * Requires a verified email before the route runs.
 *
 * The product rule is that an unverified account may look after itself — read
 * its own data, edit its profile, change its photo — and nothing else. Store
 * setup in particular must not start, because a store is a commercial identity
 * we would be publishing on behalf of an address nobody has proven they own.
 *
 * **Why a guard and not another inline check.** The rule was already being
 * re-implemented per method (`collections.service`, `updateStoreName`, …), so
 * whether an endpoint enforced it depended on whether whoever wrote it
 * remembered. Store setup spans a dozen routes across profile, policies,
 * working hours, payment account and publish; one guard on the controller
 * covers them uniformly and makes a missing check visible as a missing
 * decorator.
 *
 * Verification is read from the DATABASE, not the JWT. `isEmailVerified` is not
 * a token claim, and a token minted before verification would otherwise keep
 * the user locked out until it expired.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request?.user?.id;

    // No user means an auth guard has already rejected (or will); this guard
    // has no opinion about anonymous requests.
    if (!userId) return true;

    const user = await this.prisma.user.findUnique({
      where: { id: String(userId) },
      select: { isEmailVerified: true },
    });

    if (!user?.isEmailVerified) {
      throw new ForbiddenException(
        'Verify your email address before setting up your store.',
      );
    }

    return true;
  }
}
