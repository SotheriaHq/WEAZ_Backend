import { IsString, IsOptional, IsEnum } from 'class-validator';

export class SubmitVerificationDto {
  @IsString()
  verificationPhoto1Key: string;

  @IsString()
  verificationPhoto2Key: string;

  @IsString()
  verificationNinKey: string;

  @IsOptional()
  @IsString()
  verificationCacKey?: string;

  @IsString()
  verificationAddress: string;

  @IsString()
  verificationClientEstimate: string;
}

export class ReviewVerificationDto {
  @IsEnum(['APPROVED', 'REJECTED'])
  decision: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  rejectionReason?: string;
}
