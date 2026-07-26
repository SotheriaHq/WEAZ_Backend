import { Transform } from 'class-transformer';
import {
  registerDecorator,
  type ValidationOptions,
  type ValidationArguments,
} from 'class-validator';
import {
  isEmptyPhone,
  isValidPhone,
  normalizePhoneToE164,
  PHONE_INVALID_MESSAGE,
} from '../utils/phone-number';

/**
 * class-transformer: empty stays empty; valid → E.164; invalid left as-is
 * so @IsPhoneNumberField can fail with a clear message.
 */
export function ToE164Phone(): PropertyDecorator {
  return Transform(({ value }) => {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string') return value;
    if (isEmptyPhone(value)) return typeof value === 'string' ? value.trim() : value;
    return normalizePhoneToE164(value) ?? value.trim();
  });
}

/**
 * class-validator: empty passes (pair with @IsOptional or @IsNotEmpty as needed);
 * non-empty must be a valid phone (post-transform E.164 or still-valid original).
 */
export function IsPhoneNumberField(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isPhoneNumberField',
      target: object.constructor,
      propertyName: String(propertyName),
      options: {
        message: PHONE_INVALID_MESSAGE,
        ...validationOptions,
      },
      validator: {
        validate(value: unknown, _args: ValidationArguments) {
          if (value === undefined || value === null) return true;
          if (typeof value === 'string' && isEmptyPhone(value)) return true;
          return isValidPhone(value);
        },
        defaultMessage() {
          return PHONE_INVALID_MESSAGE;
        },
      },
    });
  };
}
