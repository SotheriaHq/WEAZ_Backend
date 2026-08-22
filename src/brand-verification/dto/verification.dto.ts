import { applyDecorators } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  VerificationAuthorityType,
  VerificationIdDocumentType,
  VerificationLegalEntityType,
  VerificationOwnerGender,
  VerificationSignatureMethod,
} from '@prisma/client';
import {
  IsPhoneNumberField,
  ToE164Phone,
} from '../../common/decorators/is-phone-number.decorator';
import { PHONE_E164_MAX_LENGTH } from '../../common/utils/phone-number';

/**
 * Trims before validating, so whitespace cannot satisfy a required field.
 *
 * `@IsNotEmpty()` on its own rejects `''` but happily accepts `'   '`, which
 * is the same hole with an extra step.
 */
const TrimmedRequiredString = () =>
  applyDecorators(
    Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)),
    IsString(),
    IsNotEmpty(),
  );

/**
 * Every field here is load-bearing: `businessAddress` is what
 * `companyLocation` is built from, and it is printed on the verification
 * letter. `@IsString()` alone let `{ street: '', city: '', state: '',
 * country: '' }` through — a submission that passes validation and produces an
 * empty address — so each one is now required and trimmed.
 */
export class VerificationBusinessAddressDto {
  @TrimmedRequiredString()
  street: string;

  @TrimmedRequiredString()
  city: string;

  @TrimmedRequiredString()
  state: string;

  @TrimmedRequiredString()
  country: string;
}

export class VerificationReasonDto {
  @IsString()
  code: string;

  @IsString()
  label: string;

  @IsOptional()
  @IsString()
  customReason?: string;
}

export class VerificationInfoItemDto {
  @IsString()
  field: string;

  @IsString()
  label: string;

  @IsOptional()
  @IsString()
  message?: string;
}

export class SubmitBrandVerificationDto {
  @TrimmedRequiredString()
  ownerLegalFirstName: string;

  @TrimmedRequiredString()
  ownerLegalLastName: string;

  @IsDateString()
  ownerDateOfBirth: string;

  @IsEnum(VerificationOwnerGender)
  ownerGender: VerificationOwnerGender;

  @IsOptional()
  @ToE164Phone()
  @IsString()
  @IsPhoneNumberField()
  @MaxLength(PHONE_E164_MAX_LENGTH)
  ownerPhoneNumber?: string;

  @TrimmedRequiredString()
  ownerNin: string;

  @TrimmedRequiredString()
  cacNumber: string;

  @ValidateNested()
  @Type(() => VerificationBusinessAddressDto)
  businessAddress: VerificationBusinessAddressDto;

  @IsEnum(VerificationIdDocumentType)
  idDocumentType: VerificationIdDocumentType;

  @TrimmedRequiredString()
  idDocumentNumber: string;

  @IsOptional()
  @IsDateString()
  idDocumentExpiryDate?: string;

  @IsEnum(VerificationLegalEntityType)
  legalEntityType: VerificationLegalEntityType;

  @IsEnum(VerificationAuthorityType)
  authorityType: VerificationAuthorityType;

  @IsOptional()
  @IsString()
  authorityProofKey?: string;

  @IsOptional()
  @IsString()
  authorityProofDescription?: string;

  @TrimmedRequiredString()
  ownerPhotoKey: string;

  @TrimmedRequiredString()
  idDocumentFrontKey: string;

  @IsOptional()
  @IsString()
  idDocumentBackKey?: string;

  @TrimmedRequiredString()
  cacCertificateKey: string;

  @TrimmedRequiredString()
  letterKey: string;

  @IsOptional()
  @IsString()
  expectedUpdatedAt?: string;
}

export class SaveVerificationDraftDto {
  @IsObject()
  draftData: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  currentStep?: number;
}

export class SignVerificationLetterDto {
  @IsString()
  @MaxLength(1_000_000)
  signatureImage: string;

  @IsEnum(VerificationSignatureMethod)
  signatureMethod: VerificationSignatureMethod;

  @IsInt()
  @Min(1)
  letterVersion: number;

  @IsOptional()
  @IsString()
  typedSignatureText?: string;
}

export class ResubmitVerificationInfoDto {
  @IsOptional()
  @IsString()
  ownerLegalFirstName?: string;

  @IsOptional()
  @IsString()
  ownerLegalLastName?: string;

  @IsOptional()
  @IsDateString()
  ownerDateOfBirth?: string;

  @IsOptional()
  @IsEnum(VerificationOwnerGender)
  ownerGender?: VerificationOwnerGender;

  @IsOptional()
  @ToE164Phone()
  @IsString()
  @IsPhoneNumberField()
  @MaxLength(PHONE_E164_MAX_LENGTH)
  ownerPhoneNumber?: string;

  @IsOptional()
  @IsString()
  ownerNin?: string;

  @IsOptional()
  @IsString()
  cacNumber?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => VerificationBusinessAddressDto)
  businessAddress?: VerificationBusinessAddressDto;

  @IsOptional()
  @IsEnum(VerificationIdDocumentType)
  idDocumentType?: VerificationIdDocumentType;

  @IsOptional()
  @IsString()
  idDocumentNumber?: string;

  @IsOptional()
  @IsDateString()
  idDocumentExpiryDate?: string;

  @IsOptional()
  @IsEnum(VerificationLegalEntityType)
  legalEntityType?: VerificationLegalEntityType;

  @IsOptional()
  @IsEnum(VerificationAuthorityType)
  authorityType?: VerificationAuthorityType;

  @IsOptional()
  @IsString()
  authorityProofKey?: string;

  @IsOptional()
  @IsString()
  authorityProofDescription?: string;

  @IsOptional()
  @IsString()
  ownerPhotoKey?: string;

  @IsOptional()
  @IsString()
  idDocumentFrontKey?: string;

  @IsOptional()
  @IsString()
  idDocumentBackKey?: string;

  @IsOptional()
  @IsString()
  cacCertificateKey?: string;

  @IsOptional()
  @IsString()
  letterKey?: string;
}

export class PresignVerificationUploadDto {
  @IsString()
  fileName: string;

  @IsString()
  contentType: string;

  @IsString()
  documentType: string;
}

export class FinalizeVerificationUploadDto {
  @IsString()
  fileId: string;

  @IsString()
  key: string;

  @IsString()
  actualMimeType: string;

  @IsNumber()
  actualSize: number;
}

export class ReviewBrandVerificationDto {
  @IsEnum(['APPROVED', 'REJECTED'])
  decision: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VerificationReasonDto)
  rejectionReasons?: VerificationReasonDto[];

  @IsOptional()
  @IsString()
  expectedUpdatedAt?: string;
}

export class RequestVerificationInfoDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VerificationInfoItemDto)
  items: VerificationInfoItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  generalMessage?: string;

  @IsOptional()
  @IsString()
  expectedUpdatedAt?: string;
}

export class VerificationNoteDto {
  @IsString()
  @MaxLength(2000)
  text: string;
}

export class VerificationVersionDto {
  @IsOptional()
  @IsDateString()
  expectedUpdatedAt?: string;
}

export class VerificationNudgePreferenceDto {
  @IsBoolean()
  nudgeOptOut: boolean;
}
