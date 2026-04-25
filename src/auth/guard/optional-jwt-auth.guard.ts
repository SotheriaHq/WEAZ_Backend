import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Optional JWT Auth Guard
 * Extracts user from JWT token if present, but doesn't block unauthenticated requests
 * Useful for routes that work for both authenticated and anonymous users
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any) {
    // Don't throw error if user is not found (allow anonymous access)
    // Just return user (or undefined if not authenticated)
    return user;
  }
}
