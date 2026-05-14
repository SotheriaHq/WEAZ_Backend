import { IsString, MinLength } from 'class-validator';

export class ConfirmEmailChangeDto {
  @IsString()
  @MinLength(32)
  token: string;
}
