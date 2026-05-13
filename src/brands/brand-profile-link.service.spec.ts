import { BrandProfileLinkService } from './brand-profile-link.service';

describe('BrandProfileLinkService', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.WEB_APP_URL = 'https://threadly.test';
    delete process.env.FRONTEND_URL;
    delete process.env.APP_ENV;
    delete process.env.DEPLOY_ENV;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses the public username route when a brand username exists', () => {
    const service = new BrandProfileLinkService();

    expect(
      service.getBrandProfileLinks({
        ownerId: 'owner-1',
        username: 'maison-vant',
      }),
    ).toEqual({
      publicProfileUrl: 'https://threadly.test/u/maison-vant',
      qrTargetUrl: 'https://threadly.test/u/maison-vant',
      shareUrl: 'https://threadly.test/u/maison-vant',
    });
  });

  it('falls back to the public profile id route when username is missing', () => {
    const service = new BrandProfileLinkService();

    expect(
      service.getBrandProfileLinks({
        ownerId: 'owner-1',
        username: null,
      }),
    ).toEqual({
      publicProfileUrl: 'https://threadly.test/profile/owner-1',
      qrTargetUrl: 'https://threadly.test/profile/owner-1',
      shareUrl: 'https://threadly.test/profile/owner-1',
    });
  });

  it('requires an explicit public web URL in production-like environments', () => {
    delete process.env.WEB_APP_URL;
    delete process.env.FRONTEND_URL;
    process.env.NODE_ENV = 'production';
    const service = new BrandProfileLinkService();

    expect(() =>
      service.getPublicProfileUrl({
        ownerId: 'owner-1',
        username: 'maison-vant',
      }),
    ).toThrow('WEB_APP_URL');
  });

  it('rejects localhost public profile URLs in production-like environments', () => {
    process.env.WEB_APP_URL = 'http://localhost:3000';
    process.env.NODE_ENV = 'production';
    const service = new BrandProfileLinkService();

    expect(() =>
      service.getPublicProfileUrl({
        ownerId: 'owner-1',
        username: 'maison-vant',
      }),
    ).toThrow('public web URL');
  });
});
