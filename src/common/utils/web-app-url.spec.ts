import { isNonLocalEnvironment, resolveWebAppBaseUrl } from './web-app-url';

const ORIGINAL_ENV = process.env;

function resetEnv(overrides: NodeJS.ProcessEnv = {}) {
  process.env = {
    ...ORIGINAL_ENV,
    APP_ENV: undefined,
    DEPLOY_ENV: undefined,
    NODE_ENV: 'test',
    WEB_APP_URL: undefined,
    FRONTEND_URL: undefined,
    WEB_APP_USE_HTTPS: undefined,
    WEB_APP_HOST: undefined,
    WEB_APP_PORT: undefined,
    ...overrides,
  };
}

describe('web app URL resolution', () => {
  beforeEach(() => {
    resetEnv();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('prefers WEB_APP_URL and normalizes a trailing slash', () => {
    resetEnv({
      WEB_APP_URL: 'https://app.threadly.test/',
      FRONTEND_URL: 'https://fallback.threadly.test',
    });

    expect(resolveWebAppBaseUrl()).toBe('https://app.threadly.test');
  });

  it('falls back to FRONTEND_URL when WEB_APP_URL is absent', () => {
    resetEnv({
      FRONTEND_URL: 'https://frontend.threadly.test/',
    });

    expect(resolveWebAppBaseUrl()).toBe('https://frontend.threadly.test');
  });

  it('defaults local environments to localhost:3000', () => {
    resetEnv({ NODE_ENV: 'development' });

    expect(resolveWebAppBaseUrl()).toBe('http://localhost:3000');
  });

  it('allows an intentional LAN host and port for device testing', () => {
    resetEnv({
      NODE_ENV: 'development',
      WEB_APP_HOST: '192.168.110.91',
      WEB_APP_PORT: '5173',
    });

    expect(resolveWebAppBaseUrl()).toBe('http://192.168.110.91:5173');
  });

  it('uses HTTPS for local fallback only when explicitly enabled', () => {
    resetEnv({
      NODE_ENV: 'development',
      WEB_APP_USE_HTTPS: 'true',
    });

    expect(resolveWebAppBaseUrl()).toBe('https://localhost:3000');
  });

  it('treats staging and production markers as non-local', () => {
    resetEnv({ APP_ENV: 'staging' });

    expect(isNonLocalEnvironment()).toBe(true);
    expect(() => resolveWebAppBaseUrl()).toThrow(
      'WEB_APP_URL (or FRONTEND_URL) must be configured for non-local environments',
    );
  });

  it('treats sit as local-friendly and defaults to localhost when no web url is set', () => {
    resetEnv({ APP_ENV: 'sit', NODE_ENV: 'production' });

    expect(isNonLocalEnvironment()).toBe(false);
    expect(resolveWebAppBaseUrl()).toBe('http://localhost:3000');
  });

  it('ignores placeholder web urls from env templates', () => {
    resetEnv({
      APP_ENV: 'sit',
      WEB_APP_URL: 'https://<sit-frontend-domain>',
      FRONTEND_URL: 'REPLACE_ME_SIT_WEB_URL',
    });

    expect(resolveWebAppBaseUrl()).toBe('http://localhost:3000');
  });
});
