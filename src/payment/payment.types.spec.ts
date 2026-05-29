import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaymentMethod } from '@prisma/client';
import { InitializeUnifiedCheckoutDto } from './payment.types';

describe('payment DTO validation', () => {
  it('rejects invalid nested unified checkout shipping and contact payloads', async () => {
    const dto = plainToInstance(InitializeUnifiedCheckoutDto, {
      customerName: 'Ada Okafor',
      shippingAddress: {
        firstName: 'Ada',
        lastName: 'Okafor',
        street: '',
        city: 'Lagos',
        state: '',
        country: 'Nigeria',
        phone: '',
      },
      contactInfo: {
        phone: '',
        billingSameAsShipping: 'yes',
      },
      paymentMethod: PaymentMethod.PAYSTACK,
      email: 'ada@example.com',
      idempotencyKey: 'idem-checkout-1',
    });

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    expect(errors.some((error) => error.property === 'shippingAddress')).toBe(
      true,
    );
    expect(errors.some((error) => error.property === 'contactInfo')).toBe(true);
  });

  it('accepts the expected unified checkout nested payload shape', async () => {
    const dto = plainToInstance(InitializeUnifiedCheckoutDto, {
      customerName: 'Ada Okafor',
      shippingAddress: {
        firstName: 'Ada',
        lastName: 'Okafor',
        street: '1 Allen Avenue',
        apartment: 'Flat 2',
        city: 'Lagos',
        state: 'Lagos',
        postalCode: '100001',
        country: 'Nigeria',
        phone: '08030000000',
      },
      contactInfo: {
        phone: '08030000000',
        email: 'ada@example.com',
        billingSameAsShipping: true,
        billingAddress: {
          firstName: 'Ada',
          lastName: 'Okafor',
          street: '1 Allen Avenue',
          city: 'Lagos',
          state: 'Lagos',
          country: 'Nigeria',
          phone: '08030000000',
        },
        channel: 'CARD',
      },
      paymentMethod: PaymentMethod.PAYSTACK,
      email: 'ada@example.com',
      idempotencyKey: 'idem-checkout-1',
    });

    await expect(
      validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
    ).resolves.toEqual([]);
  });
});
