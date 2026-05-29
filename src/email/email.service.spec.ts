import { EventEmitter } from 'events';
import * as https from 'https';

import { ConfigService } from '@nestjs/config';

import { EmailService } from './email.service';
import { PrismaService } from 'src/prisma/prisma.service';

jest.mock('https', () => ({
  request: jest.fn(),
}));

describe('EmailService', () => {
  const createConfig = (
    overrides: Record<string, string | undefined> = {},
  ): ConfigService => {
    const values: Record<string, string | undefined> = {
      APP_NAME: 'Threadly',
      MAIL_FROM_ADDRESS: 'noreply@threadly.app',
      MAIL_FROM_NAME: 'Threadly',
      EMAIL_PROVIDER: 'mailjet',
      MAILJET_API_KEY: 'mj-key',
      MAILJET_SECRET_KEY: 'mj-secret',
      MAILJET_VALIDATE_SENDER_STATUS: 'false',
      MAILJET_ENFORCE_ACTIVE_SENDER: 'true',
      MAIL_REPLY_TO: 'support@threadly.app',
      ...overrides,
    };

    return {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
  };

  const createService = (overrides?: Record<string, string | undefined>) =>
    new EmailService(createConfig(overrides), {} as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends Mailjet delivery through the HTTP API', async () => {
    const requestMock = https.request as unknown as jest.Mock;
    let capturedRequest: any;

    requestMock.mockImplementation(
      (_options: any, callback: (response: any) => void) => {
        capturedRequest = new EventEmitter() as any;
        capturedRequest.body = '';
        capturedRequest.write = jest.fn((chunk: string | Buffer) => {
          capturedRequest.body += chunk.toString();
        });
        capturedRequest.destroy = jest.fn();
        capturedRequest.end = jest.fn(() => {
          const response = new EventEmitter() as any;
          response.statusCode = 200;
          callback(response);
          response.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                Messages: [
                  {
                    Status: 'success',
                    To: [
                      {
                        Email: 'recipient@example.com',
                        MessageUUID: 'uuid-123',
                        MessageID: 123456,
                        MessageHref:
                          'https://api.mailjet.com/v3/message/123456',
                      },
                    ],
                  },
                ],
              }),
            ),
          );
          response.emit('end');
        });

        return capturedRequest;
      },
    );

    const service = createService();

    expect(service.getDeliveryAttemptProvider()).toBe('MAILJET_API');
    expect(service.getTransportHost()).toBe('api.mailjet.com');

    const result = await service.sendNow(
      'recipient@example.com',
      'Reset your password',
      '<p>Reset</p>',
      'Reset now',
    );

    expect(result).toEqual({ providerMessageId: '123456' });
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'api.mailjet.com',
        port: 443,
        method: 'POST',
        path: '/v3.1/send',
      }),
      expect.any(Function),
    );

    expect(JSON.parse(capturedRequest.body)).toEqual(
      expect.objectContaining({
        Messages: [
          expect.objectContaining({
            From: {
              Email: 'noreply@threadly.app',
              Name: 'Threadly',
            },
            To: [{ Email: 'recipient@example.com' }],
            Subject: 'Reset your password',
            HTMLPart: '<p>Reset</p>',
            TextPart: 'Reset now',
            ReplyTo: { Email: 'support@threadly.app' },
          }),
        ],
      }),
    );
  });
});
