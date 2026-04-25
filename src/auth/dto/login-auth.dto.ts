import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString } from 'class-validator';

const INVISIBLE_AUTH_SPACING_REGEX =
  /[\u00A0\u1680\u180E\u2000-\u200D\u202F\u205F\u2060\u3000\uFEFF]/g;

const normalizeLoginIdentifierInput = (value: unknown) => {
  if (typeof value !== 'string') {
    return value;
  }
  return value
    .normalize('NFKC')
    .replace(INVISIBLE_AUTH_SPACING_REGEX, '')
    .trim();
};

export class LoginDto {
  @IsOptional()
  @Transform(({ value }) => normalizeLoginIdentifierInput(value))
  @IsEmail()
  email?: string;

  @IsOptional()
  @Transform(({ value }) => normalizeLoginIdentifierInput(value))
  @IsString()
  identifier?: string;

  @IsString()
  password: string;
}
