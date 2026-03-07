import { IsString, MinLength } from 'class-validator';

export class ConfirmAdminPasswordResetDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}
