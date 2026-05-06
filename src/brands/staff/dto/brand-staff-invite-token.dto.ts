import { IsString, MinLength } from 'class-validator';

export class BrandStaffInviteTokenDto {
  @IsString()
  @MinLength(16)
  token: string;
}
