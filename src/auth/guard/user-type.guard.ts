import {
  CanActivate,
  ExecutionContext,
  Injectable,
  BadRequestException,
} from '@nestjs/common';
import { UserType } from '@prisma/client';

@Injectable()
export class UserTypeGuard implements CanActivate {
  constructor(private readonly requiredType: UserType) {}

  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) return false;
    // If token doesn't include 'type' allow (backwards compatibility)
    if (!user.type) return true;
    if (user.type === this.requiredType) return true;
    throw new BadRequestException(
      `Endpoint requires user type ${this.requiredType}`,
    );
  }
}
