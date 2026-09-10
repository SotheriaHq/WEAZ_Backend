import {
  IsOptional,
  IsString,
  IsNotEmpty,
  Matches,
  IsUUID,
  MaxLength,
  IsIn,
} from 'class-validator';
import { PROFILE_GENDERS } from '../../common/profile-gender';
import {
  IsPhoneNumberField,
  ToE164Phone,
} from '../../common/decorators/is-phone-number.decorator';
import { PHONE_E164_MAX_LENGTH } from '../../common/utils/phone-number';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  profileImage?: string;

  @IsOptional()
  @IsUUID()
  profileImageId?: string;

  @IsOptional()
  @IsString()
  bannerImage?: string;

  @IsOptional()
  @IsUUID()
  bannerImageId?: string;

  @IsOptional()
  @ToE164Phone()
  @IsString({ message: 'Phone number must be a string' })
  @IsPhoneNumberField()
  @MaxLength(PHONE_E164_MAX_LENGTH)
  phoneNumber?: string;

  @IsOptional()
  @IsString({ message: 'Address must be a string' })
  address?: string;

  /*
    Administrative location, as picked. Sent even when cleared — an empty string
    is how a client says "erase what you have", which `@IsOptional()` alone
    would otherwise make indistinguishable from "leave it alone".
  */
  @IsOptional()
  @IsString({ message: 'Country must be a string' })
  @MaxLength(120)
  country?: string;

  @IsOptional()
  @IsString({ message: 'State must be a string' })
  @MaxLength(120)
  state?: string;

  @IsOptional()
  @IsString({ message: 'City must be a string' })
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsNotEmpty({ message: 'First name is required' })
  @IsString({ message: 'First name must be a string' })
  @Matches(/^[a-zA-Z\s-]+$/, {
    message: 'First name can only contain letters, spaces, or hyphens',
  })
  firstName?: string;

  @IsOptional()
  @IsNotEmpty({ message: 'Last name is required' })
  @IsString({ message: 'Last name must be a string' })
  @Matches(/^[a-zA-Z\s-]+$/, {
    message: 'Last name can only contain letters, spaces, or hyphens',
  })
  lastName?: string;

  @IsOptional()
  @IsIn([...PROFILE_GENDERS], {
    message: 'Gender must be Man, Woman, Non-binary, or I\'d rather not say',
  })
  gender?: (typeof PROFILE_GENDERS)[number];
}
