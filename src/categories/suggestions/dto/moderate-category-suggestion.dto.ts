import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum ModerationDecision {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class ModerateCategorySuggestionDto {
  @IsEnum(ModerationDecision)
  decision!: ModerationDecision;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  rejectionReason?: string;
}
