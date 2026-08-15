const ALLOWED_RETURN_WINDOWS = new Set(['7', '14']);
const ALLOWED_RESPONSE_TIME_SLAS = new Set(['2h', 'same-day', '24h']);
const ALLOWED_CUSTOM_ORDER_LEAD_TIMES = new Set(['1-2', '2-4', '4-7']);
/**
 * Nothing a brand promises to MAKE or DISPATCH may exceed 7 days.
 *
 * Custom-order lead time was capped here; order processing time was not capped
 * anywhere on the server and the web wizard still offered "7-14 business days",
 * so one store could advertise a 4-7 day bespoke garment and a 7-14 day
 * dispatch on stock it already holds.
 */
const ALLOWED_PROCESSING_TIMES = new Set(['1-2', '3-5', '5-7']);
const DISALLOWED_SHIPPING_REGIONS = new Set(['international']);

const LEGACY_LEAD_TIME_MAP: Record<string, string> = {
  '7-14': '4-7',
  '14-21': '4-7',
  '21-30': '4-7',
  '30-plus': '4-7',
};

// Pulled down to the longest option still allowed, not reset to the default:
// a brand that chose the slowest bracket stays on the slowest bracket.
const LEGACY_PROCESSING_TIME_MAP: Record<string, string> = {
  '7-14': '5-7',
  '14-21': '5-7',
  '21-30': '5-7',
  '30-plus': '5-7',
};

export function sanitizeShippingRegions(regions: string[] | undefined | null): string[] {
  if (!Array.isArray(regions)) return [];
  return regions.filter(
    (region) =>
      typeof region === 'string' &&
      region.trim().length > 0 &&
      !DISALLOWED_SHIPPING_REGIONS.has(region.trim().toLowerCase()),
  );
}

export function sanitizeReturnWindow(
  value: string | undefined | null,
  fallback = '14',
): string {
  const normalized = String(value ?? '').trim();
  if (ALLOWED_RETURN_WINDOWS.has(normalized)) return normalized;
  return fallback;
}

export function sanitizeResponseTimeSla(
  value: string | undefined | null,
  fallback = '24h',
): string {
  const normalized = String(value ?? '').trim();
  if (ALLOWED_RESPONSE_TIME_SLAS.has(normalized)) return normalized;
  return fallback;
}

export function sanitizeCustomOrderLeadTime(
  value: string | undefined | null,
  fallback = '2-4',
): string {
  const normalized = String(value ?? '').trim();
  if (ALLOWED_CUSTOM_ORDER_LEAD_TIMES.has(normalized)) return normalized;
  return LEGACY_LEAD_TIME_MAP[normalized] ?? fallback;
}

export function sanitizeProcessingTime(
  value: string | undefined | null,
  fallback = '3-5',
): string {
  const normalized = String(value ?? '').trim();
  if (ALLOWED_PROCESSING_TIMES.has(normalized)) return normalized;
  return LEGACY_PROCESSING_TIME_MAP[normalized] ?? fallback;
}

export function normalizeCustomOrderSettings(
  settings: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return undefined;
  }

  const next = { ...settings };
  if (typeof next.leadTime === 'string') {
    next.leadTime = sanitizeCustomOrderLeadTime(next.leadTime);
  }
  return next;
}

export function assertStorePolicyConstraints(input: {
  shippingRegions?: string[];
  returnWindow?: string;
  responseTimeSla?: string;
  processingTime?: string;
  shippingRules?: Record<string, any> | null;
}): void {
  if (input.shippingRegions !== undefined) {
    const hasDisallowed = input.shippingRegions.some((region) =>
      DISALLOWED_SHIPPING_REGIONS.has(String(region ?? '').trim().toLowerCase()),
    );
    if (hasDisallowed) {
      throw new Error('International is not a valid shipping region. Select specific countries.');
    }
  }

  if (
    input.returnWindow !== undefined &&
    !ALLOWED_RETURN_WINDOWS.has(String(input.returnWindow).trim())
  ) {
    throw new Error('Return window must be 7 or 14 days.');
  }

  if (
    input.responseTimeSla !== undefined &&
    !ALLOWED_RESPONSE_TIME_SLAS.has(String(input.responseTimeSla).trim())
  ) {
    throw new Error('Customer response commitment cannot exceed 24 hours.');
  }

  if (
    input.processingTime !== undefined &&
    !ALLOWED_PROCESSING_TIMES.has(String(input.processingTime).trim())
  ) {
    throw new Error('Order processing time cannot exceed 7 days.');
  }

  const customOrderSettings = input.shippingRules?.customOrderSettings;
  if (
    customOrderSettings &&
    typeof customOrderSettings === 'object' &&
    !Array.isArray(customOrderSettings) &&
    typeof customOrderSettings.leadTime === 'string' &&
    !ALLOWED_CUSTOM_ORDER_LEAD_TIMES.has(customOrderSettings.leadTime.trim())
  ) {
    throw new Error('Custom-order lead time cannot exceed 7 days.');
  }
}