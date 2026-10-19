import {
  Equals,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
  IsIn,
  IsUUID,
} from 'class-validator';
import { SubscriptionTierKey } from '@prisma/client';
import { Transform } from 'class-transformer';

export class SubscriptionCheckoutDto {
  @IsEnum(SubscriptionTierKey)
  tierKey: SubscriptionTierKey;

  @IsOptional()
  @IsUrl({
    require_tld: false,
    protocols: ['http', 'https'],
    require_protocol: true,
  })
  @MaxLength(2048)
  callbackUrl?: string;

  @Transform(({ obj }) => obj.recurringConsent)
  @Equals(true, {
    message:
      'Confirm recurring billing and the subscription terms before continuing.',
  })
  recurringConsent: true;

  @IsString()
  @MaxLength(64)
  legalVersion: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  expectedAmountNgn?: number;

  @IsOptional()
  @IsUUID()
  savedCardId?: string;
}

export class VerifySubscriptionDto {
  @IsString()
  @MaxLength(128)
  @Matches(/^wzsub-[a-f0-9-]+(?:-a[1-4]|-h[a-f0-9-]{36})?$/)
  reference: string;
}

export class PreviewSubscriptionDto {
  @IsEnum(SubscriptionTierKey)
  tierKey: SubscriptionTierKey;
}

export class SubscriptionHistoryQueryDto {
  @IsOptional()
  @IsIn(['BILLING', 'SUBSCRIPTIONS'])
  kind?: 'BILLING' | 'SUBSCRIPTIONS';

  @IsOptional()
  @IsUUID()
  cursor?: string;
}

export class SubscriptionPaymentMethodDto {
  @IsUUID()
  savedCardId: string;

  @Transform(({ obj }) => obj.recurringConsent)
  @Equals(true)
  recurringConsent: true;

  @IsString()
  @MaxLength(64)
  legalVersion: string;
}

export class SavedCardNicknameDto {
  @IsString()
  @MaxLength(60)
  @Matches(/^(?![\s\S]*(?:\d[\s-]*){12})[\s\S]*$/, {
    message: 'Use a nickname without a card number.',
  })
  nickname: string;
}
