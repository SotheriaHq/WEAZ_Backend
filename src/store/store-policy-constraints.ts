const ALLOWED_RETURN_WINDOWS = new Set(['7', '14']);
const ALLOWED_RESPONSE_TIME_SLAS = new Set(['2h', 'same-day', '24h']);
const ALLOWED_CUSTOM_ORDER_LEAD_TIMES = new Set(['1-2', '2-4', '4-7']);
const DISALLOWED_SHIPPING_REGIONS = new Set(['international']);

const LEGACY_LEAD_TIME_MAP: Record<string, string> = {
  '7-14': '4-7',
  '14-21': '4-7',
  '21-30': '4-7',
  '30-plus': '4-7',
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