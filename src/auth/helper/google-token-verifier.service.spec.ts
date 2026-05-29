import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';

import { GoogleTokenVerifierService } from './google-token-verifier.service';

jest.mock('google-auth-library', () => {
  const verifyIdToken = jest.fn();
  return {
    OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken })),
  };
});

describe('GoogleTokenVerifierService', () => {
  const getVerifyIdTokenMock = () =>
    (OAuth2Client as unknown as jest.Mock).mock.results[0].value
      .verifyIdToken as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    (OAuth2Client as unknown as jest.Mock).mockClear();
  });

  const createService = (env: Record<string, string | undefined>) =>
    new GoogleTokenVerifierService({
      get: jest.fn((key: string, fallback?: string) => env[key] ?? fallback),
    } as any);

  it('rejects verification when Google client ids are not configured', async () => {
    const service = createService({});

    await expect(service.verifyIdToken('token')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('verifies ID tokens against all allowed web and mobile client ids', async () => {
    const service = createService({
      GOOGLE_ALLOWED_CLIENT_IDS: 'web-client,ios-client,android-client',
    });
    const verifyIdToken = getVerifyIdTokenMock();
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub',
        email: 'ADA@example.com',
        email_verified: true,
        aud: 'ios-client',
        iss: 'https://accounts.google.com',
        name: 'Ada Okafor',
        given_name: 'Ada',
        family_name: 'Okafor',
        picture: 'https://example.com/avatar.png',
      }),
    });

    await expect(service.verifyIdToken('token')).resolves.toEqual({
      providerSubject: 'google-sub',
      email: 'ada@example.com',
      emailVerified: true,
      audience: 'ios-client',
      name: 'Ada Okafor',
      givenName: 'Ada',
      familyName: 'Okafor',
      picture: 'https://example.com/avatar.png',
    });
    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: 'token',
      audience: ['web-client', 'ios-client', 'android-client'],
    });
  });

  it('rejects unverified Google email claims', async () => {
    const service = createService({ ['GOOGLE_CLIENT_ID']: 'web-client' });
    getVerifyIdTokenMock().mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub',
        email: 'ada@example.com',
        email_verified: false,
        aud: 'web-client',
        iss: 'accounts.google.com',
      }),
    });

    await expect(service.verifyIdToken('token')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects wrong-audience tokens even if the verifier returns a payload', async () => {
    const service = createService({ ['GOOGLE_CLIENT_ID']: 'web-client' });
    getVerifyIdTokenMock().mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub',
        email: 'ada@example.com',
        email_verified: true,
        aud: 'other-client',
        iss: 'accounts.google.com',
      }),
    });

    await expect(service.verifyIdToken('token')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
