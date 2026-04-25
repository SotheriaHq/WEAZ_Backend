import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RequestAccountReactivationDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(15)
  @MaxLength(1200)
  reason: string;
}
