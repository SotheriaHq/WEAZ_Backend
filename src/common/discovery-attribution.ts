import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Discovery attribution names the Market section a bag line came from. It is
 * analytics only: price, stock, eligibility and ranking never read it, and an
 * absent or unusable value never blocks a cart or a paid order.
 *
 * The shape matches the CartItem and OrderItem database checks: a lower-case
 * section or suggestion-block key, and a position only alongside a section.
 *
 * First touch: the add that creates a bag line records where it came from.
 * Adding more of the same line, or changing its quantity, never moves that
 * credit, and a line first added without a source stays unattributed, so a
 * later visit cannot claim a purchase decision it did not start. Checkout
 * snapshots the line's source and the paid order line copies the snapshot.
 */
export const DISCOVERY_SECTION_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
/** Market rails and See All pages never place an item beyond this slot. */
export const DISCOVERY_MAX_POSITION = 500;

export class DiscoveryAttributionDto {
  @IsOptional()
  @IsString()
  @Matches(DISCOVERY_SECTION_PATTERN)
  sourceSection?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(DISCOVERY_MAX_POSITION)
  sourcePosition?: number;
}

export type DiscoveryAttribution = {
  sourceSection: string | null;
  sourcePosition: number | null;
};

/**
 * Accepts only values the database checks accept. A position without a
 * section, or any malformed value read back from a stored snapshot, becomes
 * null instead of failing the write that carries it.
 */
export function resolveDiscoveryAttribution(
  input: unknown,
): DiscoveryAttribution {
  const record =
    input && typeof input === 'object'
      ? (input as Record<string, unknown>)
      : {};
  const section =
    typeof record.sourceSection === 'string' &&
    DISCOVERY_SECTION_PATTERN.test(record.sourceSection)
      ? record.sourceSection
      : null;
  const position =
    section !== null &&
    typeof record.sourcePosition === 'number' &&
    Number.isSafeInteger(record.sourcePosition) &&
    record.sourcePosition >= 0 &&
    record.sourcePosition <= DISCOVERY_MAX_POSITION
      ? record.sourcePosition
      : null;
  return { sourceSection: section, sourcePosition: position };
}
