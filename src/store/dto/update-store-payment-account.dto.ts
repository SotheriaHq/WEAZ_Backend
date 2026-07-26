import { IsOptional, IsString, Length, MaxLength } from 'class-validator';
import {
  IsPhoneNumberField,
  ToE164Phone,
} from '../../common/decorators/is-phone-number.decorator';
import { PHONE_E164_MAX_LENGTH } from '../../common/utils/phone-number';

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
  @ToE164Phone()
  @IsString()
  @IsPhoneNumberField()
  @MaxLength(PHONE_E164_MAX_LENGTH)
  primaryContactPhone?: string;
}
