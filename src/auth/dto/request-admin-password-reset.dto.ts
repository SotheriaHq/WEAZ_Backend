import { IsEmail } from 'class-validator';

export class RequestAdminPasswordResetDto {
  @IsEmail()
  email: string;
}
