import { IsEmail, IsString, MinLength } from 'class-validator';

export class DeleteAccountDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  currentPassword: string;
}
