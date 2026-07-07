import { StreamableFile } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { TransformInterceptor } from './transform.interceptor';

describe('TransformInterceptor', () => {
  it('should be defined', () => {
    expect(new TransformInterceptor()).toBeDefined();
  });

  it('does not wrap StreamableFile binary responses', async () => {
    const interceptor = new TransformInterceptor();
    const file = new StreamableFile(Buffer.from([0xff, 0xd8, 0xff]), {
      type: 'image/jpeg',
      length: 3,
    });
    const response = {
      statusCode: 200,
      getHeader: jest.fn((name: string) =>
        name.toLowerCase() === 'content-type' ? 'image/jpeg' : undefined,
      ),
    };
    const context = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as any;
    const next = { handle: () => of(file) };

    const result = await firstValueFrom(interceptor.intercept(context, next));

    expect(result).toBe(file);
  });

  it('continues wrapping normal JSON responses', async () => {
    const interceptor = new TransformInterceptor();
    const response = {
      statusCode: 200,
      getHeader: jest.fn(() => undefined),
    };
    const context = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as any;
    const next = { handle: () => of({ ok: true }) };

    const result = await firstValueFrom(interceptor.intercept(context, next));

    expect(result).toEqual({
      statusCode: 200,
      message: 'Success',
      data: { ok: true },
    });
  });
});
