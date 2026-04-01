import {
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

export class UpdateStorePaymentAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  bankCode?: string;

  @IsOptional()
  @IsString()
  @Length(10, 10)
  accountNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  primaryContactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(254)
  primaryContactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  primaryContactPhone?: string;
}
