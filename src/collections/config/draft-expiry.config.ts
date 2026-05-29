/**
 * Collection Scheduler Configuration
 *
 * Configurable constants for draft lifecycle management.
 * These can be overridden via environment variables.
 */

// Time in days
export const DRAFT_EXPIRY_CONFIG = {
  /**
   * Days after last activity before a draft is auto-deleted
   * Default: 30 days
   * Override: DRAFT_TTL_DAYS env var
   */
  DRAFT_TTL_DAYS: parseInt(process.env.DRAFT_TTL_DAYS || '30', 10),

  /**
   * Days before expiry to send first warning notification
   * Default: 7 days (warning sent on day 23)
   * Override: DRAFT_WARNING_DAYS_FIRST env var
   */
  FIRST_WARNING_DAYS_BEFORE_EXPIRY: parseInt(
    process.env.DRAFT_WARNING_DAYS_FIRST || '7',
    10,
  ),

  /**
   * Days before expiry to send final warning notification
   * Default: 1 day (warning sent on day 29)
   * Override: DRAFT_WARNING_DAYS_FINAL env var
   */
  FINAL_WARNING_DAYS_BEFORE_EXPIRY: parseInt(
    process.env.DRAFT_WARNING_DAYS_FINAL || '1',
    10,
  ),

  /**
   * Hours after presign creation to consider orphaned
   * Default: 24 hours
   * Override: PRESIGN_TTL_HOURS env var
   */
  PRESIGN_TTL_HOURS: parseInt(process.env.PRESIGN_TTL_HOURS || '24', 10),

  /**
   * Maximum number of drafts to process in a single batch
   * Default: 100
   * Override: DRAFT_CLEANUP_BATCH_SIZE env var
   */
  CLEANUP_BATCH_SIZE: parseInt(
    process.env.DRAFT_CLEANUP_BATCH_SIZE || '100',
    10,
  ),

  /**
   * Enable/disable draft cleanup job
   * Default: true
   * Override: DRAFT_CLEANUP_ENABLED env var
   */
  CLEANUP_ENABLED: process.env.DRAFT_CLEANUP_ENABLED !== 'false',

  /**
   * Enable/disable expiry warning notifications
   * Default: true
   * Override: DRAFT_WARNINGS_ENABLED env var
   */
  WARNINGS_ENABLED: process.env.DRAFT_WARNINGS_ENABLED !== 'false',
};

// Derived values (computed from config)
export const getDraftExpiryDate = (lastActivityAt: Date): Date => {
  return new Date(
    lastActivityAt.getTime() +
      DRAFT_EXPIRY_CONFIG.DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
};

export const getFirstWarningDate = (lastActivityAt: Date): Date => {
  const daysUntilFirstWarning =
    DRAFT_EXPIRY_CONFIG.DRAFT_TTL_DAYS -
    DRAFT_EXPIRY_CONFIG.FIRST_WARNING_DAYS_BEFORE_EXPIRY;
  return new Date(
    lastActivityAt.getTime() + daysUntilFirstWarning * 24 * 60 * 60 * 1000,
  );
};

export const getFinalWarningDate = (lastActivityAt: Date): Date => {
  const daysUntilFinalWarning =
    DRAFT_EXPIRY_CONFIG.DRAFT_TTL_DAYS -
    DRAFT_EXPIRY_CONFIG.FINAL_WARNING_DAYS_BEFORE_EXPIRY;
  return new Date(
    lastActivityAt.getTime() + daysUntilFinalWarning * 24 * 60 * 60 * 1000,
  );
};

export const isExpired = (lastActivityAt: Date): boolean => {
  const now = new Date();
  return now >= getDraftExpiryDate(lastActivityAt);
};

export const getDaysUntilExpiry = (lastActivityAt: Date): number => {
  const now = new Date();
  const expiry = getDraftExpiryDate(lastActivityAt);
  const diffMs = expiry.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
};

export default DRAFT_EXPIRY_CONFIG;
