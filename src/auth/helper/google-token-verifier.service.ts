import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client, TokenPayload } from 'google-auth-library';

export type VerifiedGoogleIdentity = {
  providerSubject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  givenName: string | null;
  familyName: string | null;
  picture: string | null;
  audience: string | null;
};

@Injectable()
export class GoogleTokenVerifierService {
  private readonly client = new OAuth2Client();

  constructor(private readonly configService: ConfigService) {}

  private getAllowedClientIds(): string[] {
    const fromList = this.configService
      .get<string>('GOOGLE_ALLOWED_CLIENT_IDS', '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const fallback = this.configService
      .get<string>('GOOGLE_CLIENT_ID', '')
      .trim();
    return Array.from(new Set([...fromList, fallback].filter(Boolean)));
  }

  async verifyIdToken(idToken: string): Promise<VerifiedGoogleIdentity> {
    const token = String(idToken ?? '').trim();
    if (!token) {
      throw new BadRequestException('Google ID token is required');
    }

    const allowedClientIds = this.getAllowedClientIds();
    if (allowedClientIds.length === 0) {
      throw new ServiceUnavailableException(
        'Google sign-in is not configured',
      );
    }

    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.client.verifyIdToken({
        idToken: token,
        audience: allowedClientIds,
      });
      payload = ticket.getPayload() as typeof payload;
    } catch {
      throw new BadRequestException('Invalid Google ID token');
    }

    if (!payload?.sub) {
      throw new BadRequestException('Invalid Google ID token');
    }
    if (!payload.email) {
      throw new BadRequestException('Google account email is required');
    }
    if (payload.email_verified !== true) {
      throw new BadRequestException('Google email must be verified');
    }

    const issuer = payload.iss;
    if (issuer !== 'accounts.google.com' && issuer !== 'https://accounts.google.com') {
      throw new BadRequestException('Invalid Google ID token issuer');
    }

    const audience = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    if (!audience || !allowedClientIds.includes(audience)) {
      throw new BadRequestException('Invalid Google ID token audience');
    }

    return {
      providerSubject: payload.sub,
      email: payload.email.trim().toLowerCase(),
      emailVerified: payload.email_verified,
      name: payload.name ?? null,
      givenName: payload.given_name ?? null,
      familyName: payload.family_name ?? null,
      picture: payload.picture ?? null,
      audience,
    };
  }
}
