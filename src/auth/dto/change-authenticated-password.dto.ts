import { IsOptional, IsString, MinLength } from 'class-validator';

export class ChangeAuthenticatedPasswordDto {
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}
