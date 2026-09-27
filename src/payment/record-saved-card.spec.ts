import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { RecordSavedCardDto } from './dto/record-saved-card.dto';

/**
 * The one endpoint where a mistake means card data at rest.
 *
 * `POST /payment/saved-cards/record` exists so a buyer sees "Visa ···· 4081"
 * on their next checkout. It must be incapable of carrying the card itself —
 * not "expected not to", incapable. Two things enforce that and both are
 * pinned here: the shape has no field a PAN or CVV could arrive in, and
 * `forbidNonWhitelisted` on the controller rejects a body that invents one.
 */
describe('RecordSavedCardDto', () => {
  const build = (payload: Record<string, unknown>) =>
    plainToInstance(RecordSavedCardDto, payload);

  const valid = {
    last4: '4081',
    expMonth: '12',
    expYear: '2030',
    brand: 'Visa',
  };

  it('accepts a fingerprint', async () => {
    expect(await validate(build(valid))).toHaveLength(0);
  });

  it('refuses a full card number in last4 rather than truncating it', async () => {
    const errors = await validate(build({ ...valid, last4: '4084084084084081' }));
    expect(errors).not.toHaveLength(0);
    expect(errors[0].property).toBe('last4');
  });

  it('refuses anything that is not four digits', async () => {
    for (const bad of ['408', '40810', 'abcd', '', '40 1']) {
      const errors = await validate(build({ ...valid, last4: bad }));
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('refuses an impossible expiry', async () => {
    expect(await validate(build({ ...valid, expMonth: '13' }))).not.toHaveLength(0);
    expect(await validate(build({ ...valid, expMonth: '00' }))).not.toHaveLength(0);
    expect(await validate(build({ ...valid, expYear: '30' }))).not.toHaveLength(0);
  });

  it('has no field a card number or CVV could arrive in', () => {
    const instance = build({ ...valid });
    const allowed = Object.keys(instance);
    for (const forbidden of ['cardNumber', 'pan', 'cvv', 'cvc', 'pin', 'number']) {
      expect(allowed).not.toContain(forbidden);
    }
    // `forbidNonWhitelisted` on the controller turns an unknown key into a
    // 400, so a caller cannot smuggle one past the shape either.
    expect(allowed.sort()).toEqual(
      ['brand', 'expMonth', 'expYear', 'last4'].sort(),
    );
  });
});
