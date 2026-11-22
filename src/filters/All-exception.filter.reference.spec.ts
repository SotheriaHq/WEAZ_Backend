import {
  ConflictException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { AllExceptionsFilter } from './All-exception.filter';
import { AppException } from 'src/common/errors';

/**
 * WP-03 PR-A: error bodies gain an optional `reference` (the request id the
 * server already logs and returns as x-request-id). Additive only: every
 * legacy key keeps its value and nothing internal is added.
 */
describe('AllExceptionsFilter diagnostic reference (WP-03 PR-A)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    jest.restoreAllMocks();
  });

  const run = (exception: unknown, request: Record<string, unknown> = {}) => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ method: 'POST', url: '/bag?x=1', path: '/bag', headers: {}, ...request }),
      }),
    } as any;
    new AllExceptionsFilter().catch(exception, host);
    return { status: response.status.mock.calls[0][0], body: response.json.mock.calls[0][0] };
  };

  const REQUEST_ID = '3f2a9c1e-7b4d-4c1a-9e2f-1a2b3c4d5e6f';

  it('adds the request id as reference and leaves every legacy key as it was', () => {
    const { body } = run(new ConflictException({ message: 'Already in your bag.', code: 'CONFLICT' }), { requestId: REQUEST_ID });
    expect(body).toEqual({
      statusCode: 409,
      timestamp: expect.any(String),
      path: '/bag',
      message: 'Already in your bag.',
      code: 'CONFLICT',
      reference: REQUEST_ID,
    });
  });

  it('sends exactly the old body when there is no request id', () => {
    const { body } = run(new ConflictException('Already in your bag.'));
    expect(Object.keys(body).sort()).toEqual(['message', 'path', 'statusCode', 'timestamp']);
  });

  it('does not reflect a client-supplied id that is not a short plain token', () => {
    const { body } = run(new ConflictException('x'), { headers: { 'x-request-id': '<img src=x onerror=alert(1)>' } });
    expect(body).not.toHaveProperty('reference');
  });

  it('keeps hiding 5xx details in production while still giving the reference', () => {
    process.env.NODE_ENV = 'production';
    const { status, body } = run(
      new InternalServerErrorException('PrismaClientKnownRequestError P2002 at /app/dist/x.js'),
      { requestId: REQUEST_ID },
    );
    expect(status).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(body.reference).toBe(REQUEST_ID);
    expect(JSON.stringify(body)).not.toMatch(/prisma|P2002|\/app\//i);
  });

  it('forwards AppException code and safe message through the existing code path', () => {
    const { status, body } = run(new AppException('REFRESH_ROTATED'), { requestId: REQUEST_ID });
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'REFRESH_ROTATED', reference: REQUEST_ID });
    expect(typeof body.message).toBe('string');
  });
});
