import { EmailPriority, NotificationType } from '@prisma/client';
import {
  EMAIL_COLORS,
  escapeHtml,
  normalizeCompanyName,
  renderBrandedAppName,
  renderEmailButton,
  renderEmailShell,
} from '../email/email.branding';

const CRITICAL_SCENARIOS = new Set<string>([
  'auth.signin.new_device',
  'auth.signin.high_risk',
  'notification.LOGIN',
]);

export function getEmailScenarioKey(
  notificationType: NotificationType,
  payload: Record<string, unknown> | null | undefined,
): string {
  if (notificationType === NotificationType.LOGIN) {
    if (payload?.newDevice === true) {
      return 'auth.signin.new_device';
    }
    if (payload?.highRisk === true) {
      return 'auth.signin.high_risk';
    }
  }

  return `notification.${notificationType}`;
}

export function isEmailScenarioCritical(scenarioKey: string): boolean {
  return CRITICAL_SCENARIOS.has(scenarioKey);
}

export function getCriticalEmailScenarios(): string[] {
  return Array.from(CRITICAL_SCENARIOS.values());
}

export function getEmailPriorityForScenario(
  notificationType: NotificationType,
  scenarioKey: string,
): EmailPriority {
  if (isEmailScenarioCritical(scenarioKey)) {
    return EmailPriority.P0_SECURITY;
  }

  switch (notificationType) {
    case NotificationType.ORDER_PLACED:
    case NotificationType.ORDER_STATUS_UPDATED:
    case NotificationType.CUSTOM_ORDER_PAYMENT_RECEIVED:
    case NotificationType.CUSTOM_ORDER_REVIEW_REQUIRED:
    case NotificationType.CUSTOM_ORDER_BRAND_ACCEPTED:
    case NotificationType.CUSTOM_ORDER_BRAND_REJECTED:
    case NotificationType.CUSTOM_ORDER_PROGRESS_UPDATED:
    case NotificationType.CUSTOM_ORDER_EXTENSION_REQUESTED:
    case NotificationType.CUSTOM_ORDER_EXTENSION_RESOLVED:
    case NotificationType.CUSTOM_ORDER_BUYER_COUNTERED:
    case NotificationType.CUSTOM_ORDER_BUYER_REJECTED_EXTENSION:
    case NotificationType.CUSTOM_ORDER_DELIVERED:
    case NotificationType.CUSTOM_ORDER_ISSUE_REPORTED:
    case NotificationType.CUSTOM_ORDER_DISPUTE_CREATED:
      return EmailPriority.P1_TRANSACTIONAL;
    case NotificationType.MESSAGE_RECEIVED:
    case NotificationType.MESSAGE_UNREAD_REMINDER:
    case NotificationType.THREAD:
    case NotificationType.COMMENT:
    case NotificationType.FOLLOW:
    case NotificationType.TAG_MENTION:
      return EmailPriority.P3_SOCIAL;
    default:
      return EmailPriority.P2_OPERATIONAL;
  }
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function formatSignupDateTime(createdAtIso: string): {
  dateLabel: string;
  timeLabel: string;
} {
  const parsedDate = createdAtIso ? new Date(createdAtIso) : new Date();
  const safeDate = Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;

  return {
    dateLabel: safeDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    timeLabel: safeDate.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    }),
  };
}

function renderSignupWelcomeEmail(args: {
  appName: string;
  targetUrl?: string;
  payload: Record<string, unknown> | null | undefined;
}): { subject: string; html: string; text: string } {
  const companyName = normalizeCompanyName(args.appName);
  const payload = args.payload ?? {};

  const username =
    asTrimmedString(payload.displayName) ||
    asTrimmedString(payload.username) ||
    'there';
  const createdAtIso = asTrimmedString(payload.createdAtIso);
  const device = asTrimmedString(payload.device) || 'Unknown device';
  const location = asTrimmedString(payload.location) || 'Unknown location';
  const { dateLabel, timeLabel } = formatSignupDateTime(createdAtIso);
  const ctaUrl = asTrimmedString(args.targetUrl) || 'https://threadly.com';

  const safeUsername = escapeHtml(username);
  const safeDate = escapeHtml(dateLabel);
  const safeTime = escapeHtml(timeLabel);
  const safeDevice = escapeHtml(device);
  const safeLocation = escapeHtml(location);
  const brandedName = renderBrandedAppName(companyName);

  const html = renderEmailShell({
    appName: companyName,
    bodyHtml: `<h1 style="margin:0 0 14px;font-size:26px;line-height:1.25;color:${EMAIL_COLORS.textPrimary}">Welcome to ${brandedName}, <span style="font-style:italic;color:${EMAIL_COLORS.brandPrimaryLight};font-family:Georgia,'Times New Roman',serif;font-weight:700">${safeUsername}</span>! 👋</h1>
      <p style="margin:0 0 12px;color:${EMAIL_COLORS.textSecondary};line-height:1.7">We're thrilled to have you join Africa's most vibrant fashion social commerce community.</p>
      <p style="margin:0 0 16px;color:${EMAIL_COLORS.textSecondary};line-height:1.7">Your account was successfully created on <strong>${safeDate}</strong> at <strong>${safeTime}</strong> from <strong>${safeDevice}</strong> in <strong>${safeLocation}</strong>.</p>
      <p style="margin:0 0 12px;color:${EMAIL_COLORS.textSecondary};line-height:1.7">Here is what you can start doing right away on ${escapeHtml(companyName)}:</p>
      <ul style="margin:0 0 18px;padding-left:20px;color:${EMAIL_COLORS.textSecondary};line-height:1.8">
        <li>Update your profile as a brand and complete your account setup.</li>
        <li>Verify your identity and build trust with your audience.</li>
        <li>Explore stunning collections from verified brands and tailors.</li>
        <li>Connect directly with designers through in-app messaging.</li>
        <li>Share your style, get inspired, and shop ready-to-wear or bespoke pieces.</li>
      </ul>
      <p style="margin:24px 0 16px">${renderEmailButton(ctaUrl, 'Get Started Now', { padding: '14px 28px' })}</p>
      <p style="margin:0;color:${EMAIL_COLORS.textSecondary};line-height:1.7">Need help getting started? Our support team is always here for you.</p>`,
    footerContextText: `This email was sent because you signed up for a ${companyName} account and enabled email notifications.`,
  });

  const text = [
    `Welcome to ${args.appName}, ${username}!`,
    '',
    "We're thrilled to have you join Africa's most vibrant fashion social commerce community.",
    '',
    `Your account was successfully created on ${dateLabel} at ${timeLabel} from ${device} in ${location}.`,
    '',
    `Start now on ${args.appName}:`,
    '- Update your profile as a brand and complete your account setup.',
    '- Verify your identity and build trust with your audience.',
    '- Explore collections from verified brands and tailors.',
    '- Connect directly with designers through in-app messaging.',
    '- Share your style, get inspired, and shop ready-to-wear or bespoke pieces.',
    '',
    `Get started: ${ctaUrl}`,
    '',
    'Need help getting started? Our support team is always here for you.',
  ].join('\n');

  return {
    subject: `Welcome to ${companyName}, ${username}!`,
    html,
    text,
  };
}

function renderEmailVerifiedConfirmationEmail(args: {
  appName: string;
  targetUrl?: string;
}): { subject: string; html: string; text: string } {
  const companyName = normalizeCompanyName(args.appName);
  const safeCompanyName = escapeHtml(companyName);
  const ctaUrl = asTrimmedString(args.targetUrl) || '/profile';

  const html = renderEmailShell({
    appName: companyName,
    headerSubtitle: 'Email verification complete',
    bodyHtml: `<h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;color:${EMAIL_COLORS.textPrimary}">Your email is now verified ✅</h1>
      <p style="margin:0 0 12px;color:${EMAIL_COLORS.textSecondary};line-height:1.7">Great news, your ${safeCompanyName} account email has been confirmed successfully.</p>
      <p style="margin:0 0 12px;color:${EMAIL_COLORS.textSecondary};line-height:1.7">You can now continue with profile setup, account personalization, and secure account actions without interruption.</p>
      <ul style="margin:0 0 18px;padding-left:20px;color:${EMAIL_COLORS.textSecondary};line-height:1.8">
        <li>Complete your profile details</li>
        <li>Set up your store (for brand accounts)</li>
        <li>Start discovering and engaging with the community</li>
      </ul>
      <p style="margin:24px 0 16px">${renderEmailButton(ctaUrl, 'Continue in Threadly', { padding: '14px 28px' })}</p>
      <p style="margin:0;color:${EMAIL_COLORS.textSecondary};line-height:1.7">If this was not you, please reset your password and review your account security settings immediately.</p>`,
    footerContextText: `This confirmation was sent because your ${companyName} email verification completed successfully.`,
  });

  const text = [
    `Your ${companyName} email is now verified.`,
    '',
    `Great news, your ${companyName} account email has been confirmed successfully.`,
    '',
    'You can now:',
    '- Complete your profile details',
    '- Set up your store (for brand accounts)',
    '- Start discovering and engaging with the community',
    '',
    `Continue: ${ctaUrl}`,
    '',
    'If this was not you, reset your password and review your account security settings immediately.',
  ].join('\n');

  return {
    subject: `${companyName}: Email verified successfully`,
    html,
    text,
  };
}

export function renderNotificationEmail(args: {
  appName: string;
  heading: string;
  message: string;
  targetUrl?: string;
  notificationType?: NotificationType;
  payload?: Record<string, unknown> | null;
}): { subject: string; html: string; text: string } {
  const companyName = normalizeCompanyName(args.appName);
  const action = asTrimmedString(args.payload?.action);

  if (
    args.notificationType === NotificationType.SIGNUP &&
    action !== 'EMAIL_VERIFIED'
  ) {
    return renderSignupWelcomeEmail({
      appName: companyName,
      targetUrl: args.targetUrl,
      payload: args.payload,
    });
  }

  if (
    args.notificationType === NotificationType.SIGNUP &&
    action === 'EMAIL_VERIFIED'
  ) {
    return renderEmailVerifiedConfirmationEmail({
      appName: companyName,
      targetUrl: args.targetUrl,
    });
  }

  const cta = args.targetUrl
    ? `<p style="margin:20px 0">${renderEmailButton(args.targetUrl, `Open in ${companyName}`, { padding: '11px 18px' })}</p>`
    : '';

  const html = renderEmailShell({
    appName: companyName,
    headerSubtitle: 'Account activity update',
    bodyHtml: `<h1 style="margin:0 0 12px;font-size:22px;color:${EMAIL_COLORS.textPrimary}">${escapeHtml(args.heading)}</h1>
      <p style="margin:0 0 10px;line-height:1.7;color:${EMAIL_COLORS.textSecondary}">${escapeHtml(args.message)}</p>
      ${cta}`,
    footerContextText: `You are receiving this email because your ${companyName} account has email notifications enabled.`,
  });

  const textParts = [args.heading, '', args.message];
  if (args.targetUrl) {
    textParts.push('', `Open in ${companyName}: ${args.targetUrl}`);
  }

  return {
    subject: `${companyName}: ${args.heading}`,
    html,
    text: textParts.join('\n'),
  };
}
