import { IsEmail, IsString, MinLength } from 'class-validator';

export class ReissueTempPasswordDto {
  @IsEmail()
  actorEmail!: string;

  @IsString()
  @MinLength(1)
  actorUserIdConfirm!: string;

  @IsString()
  @MinLength(1)
  targetUserIdConfirm!: string;
}
