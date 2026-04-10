import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (String(process.env.NODE_ENV ?? '').toLowerCase() !== 'production') {
      return true;
    }

    return Boolean(await super.canActivate(context));
  }
}
