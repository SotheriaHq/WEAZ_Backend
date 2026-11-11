import 'reflect-metadata';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { StoreController } from './store.controller';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';

describe('StoreController', () => {
  it('limits provider-writing payout-account updates to three attempts per minute', () => {
    const handler = StoreController.prototype.updateStorePaymentAccount;
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, handler)).toBe(3);
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, handler)).toBe(60000);
  });
  it('applies idempotency to payout-account updates', () => {
    const interceptors =
      Reflect.getMetadata(
        INTERCEPTORS_METADATA,
        StoreController.prototype.updateStorePaymentAccount,
      ) ?? [];

    expect(interceptors).toEqual(
      expect.arrayContaining([IdempotencyInterceptor]),
    );
  });
});
