import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { LoginCodePurpose, UserType } from '@prisma/client';
import { Type } from 'class-transformer';
import { LegalAcceptanceInputDto } from 'src/legal/dto/legal-acceptance.dto';

const trimString = (value: unknown) =>
  typeof value === 'string' ? value.trim() : value;

export class GoogleAuthDto {
  @IsNotEmpty({ message: 'Google ID token is required' })
  @IsString()
  @Transform(({ value }) => trimString(value))
  idToken: string;

  @IsOptional()
  @IsEnum(UserType)
  type?: UserType;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => trimString(value))
  brandFullName?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LegalAcceptanceInputDto)
  legalAcceptances?: LegalAcceptanceInputDto[];
}

export class LoginOptionsDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email: string;
}

export class RequestEmailLoginCodeDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email: string;

  @IsOptional()
  @IsEnum(LoginCodePurpose)
  purpose?: LoginCodePurpose;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => trimString(value))
  requestId?: string;
}

export class ConfirmEmailLoginCodeDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email: string;

  @IsNotEmpty({ message: 'Verification code is required' })
  @IsString()
  @Transform(({ value }) => trimString(value))
  code: string;

  @IsOptional()
  @IsEnum(LoginCodePurpose)
  purpose?: LoginCodePurpose;
}

export class PasswordSetupDto {
  @IsNotEmpty({ message: 'Password setup token is required' })
  @IsString()
  @Transform(({ value }) => trimString(value))
  passwordSetupToken: string;

  @IsNotEmpty({ message: 'New password is required' })
  @IsString()
  newPassword: string;
}
