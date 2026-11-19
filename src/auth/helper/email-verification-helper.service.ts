import { Injectable } from '@nestjs/common';
import { buildEmailVerificationLink } from 'src/common/utils/auth-links';
import {
  issueExpiringEmailToken,
  type IssuedEmailToken,
} from '../email-link-policy';

@Injectable()
export class EmailVerificationHelperService {
  /**
   * A fresh single-use verification token. Store `stored`, email `token`.
   * Issuing a new one replaces the stored digest, so every older link stops
   * working: only the most recent email can verify.
   */
  issueVerificationToken(): IssuedEmailToken {
    return issueExpiringEmailToken();
  }

  generateVerificationLink(
    verificationToken: string,
    nextPath?: string,
    options?: { mobile?: boolean; bridgeBaseUrl?: string | null },
  ): string {
    return buildEmailVerificationLink(verificationToken, nextPath, options);
  }
}
