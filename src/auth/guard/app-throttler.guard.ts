import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { shouldEnforceThrottling } from 'src/common/logging/pino.config';

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!shouldEnforceThrottling()) {
      return true;
    }

    return Boolean(await super.canActivate(context));
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const ip = String(req.ip ?? (req.ips as string[] | undefined)?.[0] ?? 'unknown');
    const user = req.user as { id?: string; sub?: string } | undefined;
    const userId = user?.id ?? user?.sub;
    if (userId) {
      return `${ip}:user:${userId}`;
    }
    return ip;
  }
}
