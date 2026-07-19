import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateProfilePrivacyDto {
  @IsBoolean()
  @IsOptional()
  showUsername?: boolean;

  @IsBoolean()
  @IsOptional()
  showLocation?: boolean;
}
