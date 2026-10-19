import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SubscriptionCheckoutDto } from './subscription-checkout.dto';

describe('explicit recurring billing consent', () => {
  it.each(['false', 'true', 1, 0, false, null, undefined])('rejects non-literal-true consent %p even with global implicit conversion', async recurringConsent => {
    const dto = plainToInstance(SubscriptionCheckoutDto, { tierKey: 'ARU', legalVersion: '2026.10.19-v1.4', recurringConsent }, { enableImplicitConversion: true });
    expect((await validate(dto)).some(error => error.property === 'recurringConsent')).toBe(true);
  });
  it('accepts literal true', async () => {
    const dto = plainToInstance(SubscriptionCheckoutDto, { tierKey: 'ARU', legalVersion: '2026.10.19-v1.4', recurringConsent: true }, { enableImplicitConversion: true });
    expect(await validate(dto)).toEqual([]);
  });
});
