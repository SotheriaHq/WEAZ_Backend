import { PushPlatform, PushProvider } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const trimRequiredString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const trimOptionalString = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export class RegisterPushTokenDto {
  @Transform(trimRequiredString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token!: string;

  @IsOptional()
  @IsEnum(PushProvider)
  provider?: PushProvider = PushProvider.EXPO;

  @IsOptional()
  @IsEnum(PushPlatform)
  platform?: PushPlatform = PushPlatform.UNKNOWN;

  @IsOptional()
  @Transform(trimOptionalString)
  @IsString()
  @MaxLength(256)
  deviceId?: string;

  @IsOptional()
  @Transform(trimOptionalString)
  @IsString()
  @MaxLength(256)
  deviceName?: string;

  @IsOptional()
  @Transform(trimOptionalString)
  @IsString()
  @MaxLength(64)
  appVersion?: string;

  @IsOptional()
  @Transform(trimOptionalString)
  @IsString()
  @MaxLength(256)
  expoProjectId?: string;
}

export class DeactivateCurrentPushTokenDto {
  @Transform(trimRequiredString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token!: string;
}
