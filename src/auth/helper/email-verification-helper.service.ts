import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { resolveWebAppBaseUrl } from 'src/common/utils/web-app-url';

@Injectable()
export class EmailVerificationHelperService {
  private getWebAppBaseUrl(): string {
    return resolveWebAppBaseUrl();
  }

  private sanitizeNextPath(nextPath?: string): string | null {
    const candidate = String(nextPath ?? '').trim();
    if (!candidate) return null;
    if (!candidate.startsWith('/')) return null;
    if (candidate.startsWith('//')) return null;
    return candidate;
  }

  generateVerificationCode(): string {
    // Single-use opaque token used in verification links.
    return randomBytes(24).toString('hex');
  }

  generateVerificationLink(
    verificationToken: string,
    nextPath?: string,
  ): string {
    const baseUrl = this.getWebAppBaseUrl();
    const sanitizedNextPath = this.sanitizeNextPath(nextPath);
    const nextQuery = sanitizedNextPath
      ? `&next=${encodeURIComponent(sanitizedNextPath)}`
      : '';
    return `${baseUrl}/verify-email?token=${encodeURIComponent(verificationToken)}${nextQuery}`;
  }
}
