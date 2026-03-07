import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum ReactivationDecision {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class ReviewReactivationRequestDto {
  @IsEnum(ReactivationDecision)
  decision: ReactivationDecision;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  adminNote?: string;
}
