import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { buildEmailVerificationLink } from 'src/common/utils/auth-links';

@Injectable()
export class EmailVerificationHelperService {
  generateVerificationCode(): string {
    // Single-use opaque token used in verification links.
    return randomBytes(24).toString('hex');
  }

  generateVerificationLink(
    verificationToken: string,
    nextPath?: string,
    options?: { mobile?: boolean; bridgeBaseUrl?: string | null },
  ): string {
    return buildEmailVerificationLink(verificationToken, nextPath, options);
  }
}
