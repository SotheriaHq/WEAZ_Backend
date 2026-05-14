import { IsString, MinLength } from 'class-validator';

export class DeleteAccountDto {
  @IsString()
  confirmationWord: string;

  @IsString()
  @MinLength(8)
  currentPassword: string;
}
