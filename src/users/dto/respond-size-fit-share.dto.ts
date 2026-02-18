import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum SizeFitShareDecision {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  REVOKE = 'REVOKE',
}

export class RespondSizeFitShareDto {
  @IsEnum(SizeFitShareDecision)
  decision: SizeFitShareDecision;

  @IsOptional()
  @IsString()
  note?: string;
}

