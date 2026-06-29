import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { LegalAcceptanceSource, LegalDocumentKey } from '@prisma/client';

export class LegalAcceptanceInputDto {
  @IsEnum(LegalDocumentKey)
  documentKey: LegalDocumentKey;

  @IsString()
  version: string;
}

export class LegalAcceptDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LegalAcceptanceInputDto)
  acceptances: LegalAcceptanceInputDto[];

  @IsOptional()
  @IsEnum(LegalAcceptanceSource)
  source?: LegalAcceptanceSource;

  @IsOptional()
  @IsString()
  surface?: string;

  @IsOptional()
  @IsString()
  appVersion?: string;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class LegalActionDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LegalAcceptanceInputDto)
  legalAcceptances?: LegalAcceptanceInputDto[];

  @IsOptional()
  @IsString()
  appVersion?: string;

  @IsOptional()
  @IsString()
  locale?: string;
}
