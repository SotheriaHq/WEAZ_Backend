import { IsEmail, IsString, MinLength } from 'class-validator';

export class RequestEmailChangeDto {
  @IsEmail()
  newEmail: string;

  @IsString()
  @MinLength(8)
  currentPassword: string;
}
