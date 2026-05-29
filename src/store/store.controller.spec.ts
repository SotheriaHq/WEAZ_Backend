import 'reflect-metadata';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { StoreController } from './store.controller';

describe('StoreController', () => {
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
