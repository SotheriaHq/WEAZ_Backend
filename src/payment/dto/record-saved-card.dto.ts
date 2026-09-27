import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * A card the buyer wants to see again next time — NOT the card itself.
 *
 * This endpoint accepts a fingerprint and nothing more: the brand, the bank,
 * the last four digits and the expiry. There is deliberately no field for a
 * card number, a CVV or a PIN, and `last4` is pinned to exactly four digits by
 * the validator, so a caller that tried to post a full PAN into it is rejected
 * at the boundary rather than trusted to have trimmed it. Keeping the shape
 * incapable of carrying card data is what keeps this endpoint outside PCI
 * scope — a comment asking callers to be careful would not.
 *
 * The money still moves through Paystack's own window. What is stored here is
 * only what the buyer needs to recognise the card in a list; when Paystack
 * later returns a reusable authorization for a completed payment, THAT is what
 * makes the card chargeable, and it is written by the payment path, not here.
 */
export class RecordSavedCardDto {
  /** Exactly four digits. Anything longer is refused, not truncated. */
  @IsString()
  @Matches(/^[0-9]{4}$/, {
    message: 'last4 must be exactly the last four digits of the card',
  })
  last4!: string;

  /** 01–12. */
  @IsString()
  @Matches(/^(0[1-9]|1[0-2])$/, { message: 'expMonth must be 01-12' })
  expMonth!: string;

  /** Four-digit year. */
  @IsString()
  @Matches(/^[0-9]{4}$/, { message: 'expYear must be a four-digit year' })
  expYear!: string;

  /** Visa / Mastercard / Verve — detected in the browser, never authoritative. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  brand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  bank?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  holderName?: string;
}
