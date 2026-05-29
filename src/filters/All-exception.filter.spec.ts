import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './All-exception.filter';

describe('AllExceptionsFilter', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    jest.restoreAllMocks();
  });

  const createHost = () => {
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const request = {
      method: 'POST',
      url: '/auth/login?token=raw-token',
      path: '/auth/login',
    };
    return {
      response,
      host: {
        switchToHttp: () => ({
          getResponse: () => response,
          getRequest: () => request,
        }),
      } as any,
    };
  };

  it('redacts sensitive validation values and removes query strings', () => {
    const filter = new AllExceptionsFilter();
    const { host, response } = createHost();

    filter.catch(
      new BadRequestException({
        message: 'Validation failed',
        errors: [{ property: 'password', value: 'RawPassword123!' }],
      }),
      host,
    );

    const payload = response.json.mock.calls[0][0];
    expect(payload.path).toBe('/auth/login');
    expect(JSON.stringify(payload)).not.toContain('RawPassword123!');
    expect(payload.errors[0].value).toBe('[REDACTED]');
  });

  it('does not expose stack traces or internal 500 details in production', () => {
    process.env.NODE_ENV = 'production';
    const filter = new AllExceptionsFilter();
    const loggerSpy = jest.spyOn((filter as any).logger, 'error');
    const { host, response } = createHost();

    filter.catch(
      new InternalServerErrorException('database stack secret'),
      host,
    );

    const payload = response.json.mock.calls[0][0];
    expect(JSON.stringify(payload)).not.toContain('database stack secret');
    expect(JSON.stringify(payload)).not.toContain('stack');
    expect(loggerSpy.mock.calls[0][1]).toBeUndefined();
  });
});
