import { IsEmail, IsString, MinLength } from 'class-validator';

export class CompleteAdminFirstLoginResetDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  currentPassword: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}
