import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EmailVerificationHelperService {
  constructor(private readonly configService: ConfigService) {}

  generateVerificationCode(): string {
    return randomBytes(3).toString('hex').slice(0, 6).toUpperCase();
  }

  generateVerificationLink(userId: string, code: string): string {
    const baseUrl = this.configService.get<string>('WEB_APP_URL');
    if (!baseUrl) {
      throw new Error(
        'WEB_APP_URL is not configured. Cannot generate verification link.',
      );
    }
    const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    return `${trimmedBase}/auth/verify-email?userId=${userId}&code=${code}`;
  }
}
