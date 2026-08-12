import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

import {
  IsPhoneNumberField,
  ToE164Phone,
} from '../../common/decorators/is-phone-number.decorator';
import { PHONE_E164_MAX_LENGTH } from '../../common/utils/phone-number';

export class RequestPhoneChangeDto {
  @ApiProperty({ example: '+2348012345678' })
  @ToE164Phone()
  @IsString({ message: 'Phone number must be a string' })
  @IsPhoneNumberField()
  @MaxLength(PHONE_E164_MAX_LENGTH)
  phoneNumber!: string;
}

export class ConfirmPhoneChangeDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  // Exactly six digits. A looser rule here would let a typo reach the verify
  // path and burn one of the five attempts on input that could never match.
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from your email' })
  code!: string;
}
