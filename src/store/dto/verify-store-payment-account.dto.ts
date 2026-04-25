import { IsString, Length, MaxLength } from 'class-validator';

export class VerifyStorePaymentAccountDto {
  @IsString()
  @MaxLength(20)
  bankCode!: string;

  @IsString()
  @Length(10, 10)
  accountNumber!: string;
}
