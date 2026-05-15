export type DesignDomainWriteMode = 'legacy' | 'dual' | 'design';

export function getDesignDomainWriteMode(
  rawValue = process.env.DESIGN_DOMAIN_WRITE_MODE,
): DesignDomainWriteMode {
  const normalized = String(rawValue ?? 'legacy').trim().toLowerCase();
  if (normalized === 'dual') return 'dual';
  if (normalized === 'design') return 'design';
  return 'legacy';
}
