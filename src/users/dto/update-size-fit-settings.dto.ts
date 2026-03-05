import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export enum SizeFitVisibilityDto {
  PUBLIC = 'PUBLIC',
  PRIVATE = 'PRIVATE',
}

export enum SizeFitSharePolicyDto {
  OWNER_ONLY = 'OWNER_ONLY',
  REQUIRE_PERMISSION = 'REQUIRE_PERMISSION',
  ALLOW_ANYONE = 'ALLOW_ANYONE',
}

export class UpdateSizeFitSettingsDto {
  @IsOptional()
  @IsEnum(SizeFitVisibilityDto)
  visibility?: SizeFitVisibilityDto;

  @IsOptional()
  @IsEnum(SizeFitSharePolicyDto)
  sharePolicy?: SizeFitSharePolicyDto;

  @IsOptional()
  @IsBoolean()
  notifyOnShare?: boolean;

  @IsOptional()
  @IsInt()
  @Min(14)
  @Max(90)
  requireUpdateEveryDays?: number;
}
