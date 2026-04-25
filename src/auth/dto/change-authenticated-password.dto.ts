import { IsOptional, IsString, MinLength } from 'class-validator';
import { PASSWORD_POLICY_MIN_LENGTH } from '../helper/password-policy.helper';

export class ChangeAuthenticatedPasswordDto {
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsString()
  @MinLength(PASSWORD_POLICY_MIN_LENGTH, {
    message: `Password must be at least ${PASSWORD_POLICY_MIN_LENGTH} characters long`,
  })
  newPassword: string;
}
