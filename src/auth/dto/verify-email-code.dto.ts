import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';

export class VerifyEmailCodeDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @Length(1, 256)
  @Matches(/^\S+$/)
  code: string;
}
