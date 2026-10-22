/**
 * Event catalog and delivery policy.
 *
 *   immediate — one Telegram message per business fact (deduplicated by its
 *               idempotency key), plus a report counter.
 *   threshold — counted; ONE message when the count reaches `threshold`
 *               inside a rolling bucket of `windowMinutes`.
 *   count     — never messaged on its own; appears only in the 07:00/22:00
 *               reports. Expected user mistakes live here.
 *
 * Every event is counted in hourly Redis buckets regardless of policy, which is
 * what the reports read for failures that leave no database row.
 */
export type MonitoringSeverity = 'info' | 'warning' | 'error' | 'critical';

export type MonitoringEventKey =
  | 'user.registered'
  | 'brand.registered'
  | 'auth.signup_system_failure'
  | 'auth.signup_rejected'
  | 'brand.verification_decided'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'checkout.completed'
  | 'design.publish_failed'
  | 'operational.alert'
  | 'http.server_error'
  | 'http.auth_failure'
  | 'sentry.alert'
  | 'sentry.ignored'
  | 'infra.alert';

export type EventPolicy = {
  title: string;
  severity: MonitoringSeverity;
  delivery: 'immediate' | 'threshold' | 'count';
  threshold?: number;
  windowMinutes?: number;
  /** Label used for this counter in the scheduled reports. */
  reportLabel: string;
};

export const EVENT_POLICY: Record<MonitoringEventKey, EventPolicy> = {
  'user.registered': {
    title: 'New user registered',
    severity: 'info',
    delivery: 'immediate',
    reportLabel: 'Shopper sign-ups (live events)',
  },
  'brand.registered': {
    title: 'New brand registered',
    severity: 'info',
    delivery: 'immediate',
    reportLabel: 'Brand sign-ups (live events)',
  },
  'auth.signup_system_failure': {
    title: 'Sign-up failed (system error)',
    severity: 'error',
    delivery: 'immediate',
    reportLabel: 'Sign-up system failures',
  },
  'auth.signup_rejected': {
    title: 'Sign-up rejected',
    severity: 'warning',
    // Duplicate emails, password policy, missing fields: ordinary mistakes.
    // A burst still matters (broken form, bot traffic), hence the threshold.
    delivery: 'threshold',
    threshold: 15,
    windowMinutes: 60,
    reportLabel: 'Sign-ups rejected (validation)',
  },
  'brand.verification_decided': {
    title: 'Brand verification decision',
    severity: 'info',
    delivery: 'immediate',
    reportLabel: 'Brand verification decisions',
  },
  'payment.succeeded': {
    title: 'Payment succeeded',
    severity: 'info',
    delivery: 'immediate',
    reportLabel: 'Payments succeeded (live events)',
  },
  'payment.failed': {
    title: 'Payment failed',
    severity: 'warning',
    delivery: 'immediate',
    reportLabel: 'Payments failed/cancelled/expired (live events)',
  },
  'checkout.completed': {
    title: 'Order placed',
    severity: 'info',
    delivery: 'immediate',
    reportLabel: 'Checkouts completed (live events)',
  },
  'design.publish_failed': {
    title: 'Design publish failed',
    severity: 'warning',
    delivery: 'threshold',
    threshold: 3,
    windowMinutes: 60,
    reportLabel: 'Design publish failures (client-reported)',
  },
  'operational.alert': {
    title: 'Operational alert',
    severity: 'error',
    delivery: 'immediate',
    reportLabel: 'Operational alerts forwarded',
  },
  'http.server_error': {
    title: 'Repeated server errors (HTTP 5xx)',
    severity: 'error',
    // Each 5xx already reaches Sentry; Telegram only hears about bursts.
    delivery: 'threshold',
    threshold: 20,
    windowMinutes: 60,
    reportLabel: 'HTTP 5xx responses',
  },
  'http.auth_failure': {
    title: 'Auth/permission failures',
    severity: 'warning',
    delivery: 'count',
    reportLabel: 'HTTP 401/403 responses',
  },
  'sentry.alert': {
    title: 'Sentry alert',
    severity: 'error',
    delivery: 'immediate',
    reportLabel: 'Sentry alerts received',
  },
  'sentry.ignored': {
    title: 'Sentry alert ignored (other environment)',
    severity: 'info',
    delivery: 'count',
    reportLabel: 'Sentry alerts ignored (other environments)',
  },
  'infra.alert': {
    title: 'Infrastructure alert',
    severity: 'critical',
    delivery: 'immediate',
    reportLabel: 'Infrastructure alerts',
  },
};

export const SEVERITY_ICON: Record<MonitoringSeverity, string> = {
  info: '🟢',
  warning: '🟠',
  error: '🔴',
  critical: '🚨',
};
