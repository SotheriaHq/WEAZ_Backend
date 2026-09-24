import { EmailPriority, NotificationType } from '@prisma/client';
import {
  EMAIL_COLORS,
  escapeHtml,
  normalizeCompanyName,
  renderBrandedAppName,
  renderEmailButton,
  renderEmailLink,
  renderEmailShell,
  resolveAppUrl,
} from '../email/email.branding';
import { collectionPublishedEmail } from '../email/email.templates';

const NT_BAG_ITEM_ADDED = 'BAG_ITEM_ADDED' as NotificationType;
const NT_BAG_CHECKOUT_REMINDER = 'BAG_CHECKOUT_REMINDER' as NotificationType;

const CRITICAL_SCENARIOS = new Set<string>([
  'auth.signin.new_device',
  'auth.signin.high_risk',
  'notification.LOGIN',
  'notification.LOGOUT_ALL',
]);

const MVP_DEFAULT_EMAIL_NOTIFICATION_TYPES = new Set<NotificationType>([
  NotificationType.SIGNUP,
  NotificationType.LOGOUT,
  NotificationType.ORDER_PLACED,
  NotificationType.ORDER_STATUS_UPDATED,
  NT_BAG_ITEM_ADDED,
  NT_BAG_CHECKOUT_REMINDER,
  NotificationType.COLLECTION_UPLOAD,
  NotificationType.PRODUCT_UPLOAD,
  NotificationType.CONTENT_SUBMITTED_FOR_REVIEW,
  NotificationType.CONTENT_REVIEW_APPROVED,
  NotificationType.CONTENT_REVIEW_REJECTED,
  NotificationType.CONTENT_CHANGES_REQUESTED,
  NotificationType.CONTENT_RESUBMITTED,
  NotificationType.CONTENT_PUBLISHED,
  NotificationType.CONTENT_REVIEW_FAILED,
  NotificationType.VERIFICATION_SUBMITTED,
  NotificationType.VERIFICATION_IN_REVIEW,
  NotificationType.VERIFICATION_INFO_REQUESTED,
  NotificationType.VERIFICATION_INFO_RESUBMITTED,
  NotificationType.VERIFICATION_APPROVED,
  NotificationType.VERIFICATION_REJECTED,
  NotificationType.VERIFICATION_CANCELLED,
  NotificationType.VERIFICATION_CANCELLED_ADMIN,
  NotificationType.VERIFICATION_COOLDOWN_EXPIRED,
  NotificationType.VERIFICATION_NUDGE,
  NotificationType.VERIFICATION_SLA_WARNING,
  NotificationType.VERIFICATION_SLA_BREACH,
  NotificationType.VERIFICATION_REVIEW_DELAYED,
  NotificationType.REVIEW_HIDDEN_BY_ADMIN,
  NotificationType.ADMIN_ACTION,
  NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
  NotificationType.MESSAGE_MODERATED,
  NotificationType.MESSAGE_THREAD_REOPENED,
  NotificationType.CUSTOM_ORDER_PAYMENT_RECEIVED,
  NotificationType.CUSTOM_ORDER_REVIEW_REQUIRED,
  NotificationType.CUSTOM_ORDER_BRAND_ACCEPTED,
  NotificationType.CUSTOM_ORDER_BRAND_REJECTED,
  NotificationType.CUSTOM_ORDER_PROGRESS_UPDATED,
  NotificationType.CUSTOM_ORDER_EXTENSION_REQUESTED,
  NotificationType.CUSTOM_ORDER_EXTENSION_RESOLVED,
  NotificationType.CUSTOM_ORDER_BUYER_COUNTERED,
  NotificationType.CUSTOM_ORDER_BUYER_REJECTED_EXTENSION,
  NotificationType.CUSTOM_ORDER_DELIVERED,
  NotificationType.CUSTOM_ORDER_ACCEPTANCE_WINDOW_REMINDER,
  NotificationType.CUSTOM_ORDER_ISSUE_REPORTED,
  NotificationType.CUSTOM_ORDER_DISPUTE_CREATED,
  NotificationType.CUSTOM_ORDER_STALE_STAGE_WARNING,
  NotificationType.CUSTOM_ORDER_ACCEPTANCE_SLA_RISK,
  NotificationType.ADMIN_EMAIL_CHANGE_REQUESTED,
  NotificationType.ADMIN_EMAIL_CHANGE_APPROVED,
  NotificationType.ADMIN_EMAIL_CHANGE_REJECTED,
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

export function isEmailScenarioEnabledByDefault(scenarioKey: string): boolean {
  if (isEmailScenarioCritical(scenarioKey)) {
    return true;
  }

  const match = scenarioKey.match(/^notification\.(.+)$/);
  if (!match) {
    return true;
  }

  return MVP_DEFAULT_EMAIL_NOTIFICATION_TYPES.has(match[1] as NotificationType);
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
    case NT_BAG_ITEM_ADDED:
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
    case NT_BAG_CHECKOUT_REMINDER:
      return EmailPriority.P2_OPERATIONAL;
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
  const ctaUrl = asTrimmedString(args.targetUrl) || resolveAppUrl('/');

  const safeUsername = escapeHtml(username);
  const safeDate = escapeHtml(dateLabel);
  const safeTime = escapeHtml(timeLabel);
  const safeDevice = escapeHtml(device);
  const safeLocation = escapeHtml(location);
  const brandedName = renderBrandedAppName(companyName);

  const html = renderEmailShell({
    appName: companyName,
    title: `🎉 Welcome to ${companyName}`,
    bodyHtml: `<p style="margin:0 0 12px;color:${EMAIL_COLORS.textSecondary};line-height:1.7">Hi <strong>${safeUsername}</strong>, welcome to ${brandedName}.</p>
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
    `Welcome to ${companyName}, ${username}!`,
    '',
    "We're thrilled to have you join Africa's most vibrant fashion social commerce community.",
    '',
    `Your account was successfully created on ${dateLabel} at ${timeLabel} from ${device} in ${location}.`,
    '',
    `Start now on ${companyName}:`,
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
    subject: `🎉 Welcome to ${companyName}, ${username}!`,
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
    title: `✅ Your ${companyName} email is verified`,
    bodyHtml: `<p style="margin:0 0 12px;color:${EMAIL_COLORS.textSecondary};line-height:1.7">Great news, your ${safeCompanyName} account email has been confirmed successfully.</p>
      <p style="margin:0 0 12px;color:${EMAIL_COLORS.textSecondary};line-height:1.7">You can now continue with profile setup, account personalization, and secure account actions without interruption.</p>
      <ul style="margin:0 0 18px;padding-left:20px;color:${EMAIL_COLORS.textSecondary};line-height:1.8">
        <li>Complete your profile details</li>
        <li>Set up your store (for brand accounts)</li>
        <li>Start discovering and engaging with the community</li>
      </ul>
      <p style="margin:24px 0 16px">${renderEmailButton(ctaUrl, 'Continue in WIEZ', { padding: '14px 28px' })}</p>
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
    subject: `✅ Your ${companyName} email is verified`,
    html,
    text,
  };
}

type NotificationEmailDetail = {
  label: string;
  value: string;
  /** When set, the value is rendered as a link to this absolute URL. */
  href?: string;
};

/**
 * An order code as the copy writes it: `#CO-F9967352`.
 *
 * Matched on text that has ALREADY been HTML-escaped. The pattern is only `#`,
 * capitals, digits and a hyphen — none of which escaping changes — so a code
 * found in escaped text is exactly the code that was written, and wrapping it
 * cannot land inside an entity.
 */
const ORDER_REFERENCE_PATTERN = /#[A-Z]{2,4}-[A-Z0-9]{6,}\b/g;

/**
 * Makes the order code in a message a link to the notification's own
 * destination.
 *
 * "#CO-F9967352 needs a quick review. Tap to open it" said "tap" and gave the
 * reader nothing to tap: the code was plain text and, for this notification,
 * there was no button either. The code IS the thing the email is about, so it
 * goes where the button goes.
 */
function linkifyOrderReferences(escapedText: string, href?: string): string {
  if (!href) return escapedText;
  return escapedText.replace(ORDER_REFERENCE_PATTERN, (code) => renderEmailLink(href, code));
}

const shortCustomOrderCode = (customOrderId: string) =>
  `#CO-${customOrderId.slice(0, 8).toUpperCase()}`;

/** A public profile, when the payload names the person by handle. */
function profileUrlFor(username: string): string | undefined {
  const handle = username.replace(/^@+/, '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(handle)) return undefined;
  return resolveAppUrl(`/u/${encodeURIComponent(handle)}`);
}

function toCurrencyDisplay(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function buildCustomOrderEmailDetails(
  payload: Record<string, unknown> | null | undefined,
  targetUrl?: string,
): NotificationEmailDetail[] {
  if (!payload) return [];

  const details: NotificationEmailDetail[] = [];
  const customOrderId = asTrimmedString(payload.customOrderId);
  const sourceTitle = asTrimmedString(payload.sourceTitle);
  const sourceBrandName = asTrimmedString(payload.sourceBrandName);
  const buyerDisplayName =
    asTrimmedString(payload.buyerDisplayName) ||
    [
      asTrimmedString(payload.buyerFirstName),
      asTrimmedString(payload.buyerLastName),
    ]
      .filter(Boolean)
      .join(' ');
  const buyerUsername = asTrimmedString(payload.buyerUsername).replace(
    /^@+/,
    '',
  );
  const buyerEmail = asTrimmedString(payload.buyerEmail);
  const amount = Number(payload.orderAmount);
  const currency = asTrimmedString(payload.currency) || 'NGN';

  /*
    The order, as the code the rest of the product shows (`#CO-F9967352`), and
    as a link to it. It used to print the raw UUID — 36 characters nobody can
    read, search for, or tap.
  */
  if (customOrderId) {
    details.push({
      label: 'Order',
      value: shortCustomOrderCode(customOrderId),
      href: targetUrl,
    });
  }
  const buyerProfileUrl = buyerUsername ? profileUrlFor(buyerUsername) : undefined;
  if (sourceTitle) {
    details.push({ label: 'Order Item', value: sourceTitle });
  }
  if (sourceBrandName) {
    details.push({ label: 'Brand', value: sourceBrandName });
  }
  if (Number.isFinite(amount) && amount > 0) {
    details.push({
      label: 'Order Total',
      value: toCurrencyDisplay(amount, currency),
    });
  }
  // A name a reader can open, not just read.
  if (buyerDisplayName) {
    details.push({ label: 'Customer', value: buyerDisplayName, href: buyerProfileUrl });
  }
  if (buyerUsername) {
    details.push({ label: 'Customer Username', value: `@${buyerUsername}`, href: buyerProfileUrl });
  }
  if (buyerEmail) {
    details.push({ label: 'Customer Email', value: buyerEmail });
  }

  return details;
}

function renderNotificationDetailsTable(
  details: NotificationEmailDetail[],
): string {
  if (!details.length) return '';

  const rows = details
    .map((detail, index) => {
      const background = index % 2 === 0 ? '#ffffff' : '#f9fafb';
      const value = detail.href
        ? renderEmailLink(detail.href, detail.value)
        : escapeHtml(detail.value);
      return `<div style="display:flex;justify-content:space-between;gap:14px;padding:10px 12px;background:${background}">
        <span style="font-size:12px;color:${EMAIL_COLORS.textMuted};font-weight:600">${escapeHtml(detail.label)}</span>
        <span style="font-size:13px;color:${EMAIL_COLORS.textPrimary};font-weight:600;text-align:right">${value}</span>
      </div>`;
    })
    .join('');

  return `<div style="margin:14px 0 8px;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">${rows}</div>`;
}

function getNotificationSubjectPrefix(
  notificationType?: NotificationType,
): string {
  switch (notificationType) {
    case NotificationType.ORDER_PLACED:
    case NotificationType.ORDER_STATUS_UPDATED:
    case NT_BAG_ITEM_ADDED:
    case NT_BAG_CHECKOUT_REMINDER:
      return '🛍️';
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
    case NotificationType.CUSTOM_ORDER_ACCEPTANCE_WINDOW_REMINDER:
    case NotificationType.CUSTOM_ORDER_ISSUE_REPORTED:
    case NotificationType.CUSTOM_ORDER_DISPUTE_CREATED:
    case NotificationType.CUSTOM_ORDER_STALE_STAGE_WARNING:
    case NotificationType.CUSTOM_ORDER_ACCEPTANCE_SLA_RISK:
      return '🧵';
    case NotificationType.MESSAGE_RECEIVED:
    case NotificationType.MESSAGE_UNREAD_REMINDER:
    case NotificationType.THREAD:
      return '💬';
    case NotificationType.VERIFICATION_APPROVED:
    case NotificationType.VERIFICATION_COOLDOWN_EXPIRED:
      return '✅';
    case NotificationType.VERIFICATION_SUBMITTED:
    case NotificationType.VERIFICATION_IN_REVIEW:
    case NotificationType.VERIFICATION_INFO_REQUESTED:
    case NotificationType.VERIFICATION_INFO_RESUBMITTED:
    case NotificationType.VERIFICATION_REJECTED:
    case NotificationType.VERIFICATION_CANCELLED:
    case NotificationType.VERIFICATION_CANCELLED_ADMIN:
    case NotificationType.VERIFICATION_NUDGE:
    case NotificationType.VERIFICATION_SLA_WARNING:
    case NotificationType.VERIFICATION_SLA_BREACH:
    case NotificationType.VERIFICATION_REVIEW_DELAYED:
      return '🏷️';
    case NotificationType.COLLECTION_UPLOAD:
    case NotificationType.PRODUCT_UPLOAD:
    case NotificationType.CONTENT_SUBMITTED_FOR_REVIEW:
    case NotificationType.CONTENT_REVIEW_APPROVED:
    case NotificationType.CONTENT_REVIEW_REJECTED:
    case NotificationType.CONTENT_CHANGES_REQUESTED:
    case NotificationType.CONTENT_RESUBMITTED:
    case NotificationType.CONTENT_PUBLISHED:
      return '🎨';
    default:
      return '';
  }
}

/**
 * What the button should say: the thing it opens, not "Open in WIEZ".
 *
 * Every notification email ended on the same generic button, so an email about
 * an order read the same as one about a message or a verification. Naming the
 * destination — "Review order #CO-F9967352" — tells the reader what pressing
 * it will do before they press it, which is the whole job of a button label.
 * An admin link says "Review" because an admin is being asked to act.
 */
function getNotificationCtaLabel(
  notificationType: NotificationType | string | undefined,
  payload: Record<string, unknown> | null | undefined,
  targetUrl: string,
  companyName: string,
): string {
  const type = String(notificationType ?? '');
  const customOrderId = asTrimmedString(payload?.customOrderId);
  const isAdminLink = /\/admin\//.test(targetUrl);

  if (customOrderId) {
    const code = shortCustomOrderCode(customOrderId);
    return isAdminLink ? `Review order ${code}` : `View order ${code}`;
  }
  if (type.startsWith('ORDER_')) return isAdminLink ? 'Review order' : 'View order';
  if (type.startsWith('MESSAGE_') || type === 'THREAD') return 'Open conversation';
  if (type.startsWith('VERIFICATION_')) return 'Open verification';
  if (type.startsWith('PAYOUT_')) return 'View payout';
  return `Open in ${companyName}`;
}

/**
 * The action block: the button, and the raw link beneath it.
 *
 * The link line is for the clients that mangle styled buttons — some Outlook
 * builds, plain-text previews, aggressive link rewriters. Without it, a broken
 * button leaves the reader with no way in at all.
 */
function renderNotificationCta(
  targetUrl: string | undefined,
  label: string,
): string {
  if (!targetUrl) return '';
  return `<div style="margin:22px 0 6px">
      ${renderEmailButton(targetUrl, label, { padding: '12px 22px' })}
      <p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:${EMAIL_COLORS.textMuted}">Button not working? Open this link: ${renderEmailLink(targetUrl, targetUrl)}</p>
    </div>`;
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

  if (args.notificationType === NotificationType.COLLECTION_UPLOAD) {
    const brandName =
      asTrimmedString(args.payload?.brandName) ||
      asTrimmedString(args.payload?.brandDisplayName) ||
      'Your brand';
    const designTitle =
      asTrimmedString(args.payload?.collectionTitle) ||
      asTrimmedString(args.payload?.collectionName) ||
      'Your design';
    const designUrl =
      asTrimmedString(args.targetUrl) ||
      asTrimmedString(args.payload?.targetUrl as string) ||
      '/';
    const result = collectionPublishedEmail(
      brandName,
      designTitle,
      designUrl,
      companyName,
    );
    return {
      subject: result.subject,
      html: result.html,
      text: result.text ?? '',
    };
  }

  // Content review lifecycle — prefer the detailed server message (includes title + Lagos time).
  const contentReviewEmailTypes = new Set<NotificationType>([
    NotificationType.CONTENT_SUBMITTED_FOR_REVIEW,
    NotificationType.CONTENT_REVIEW_APPROVED,
    NotificationType.CONTENT_REVIEW_REJECTED,
    NotificationType.CONTENT_CHANGES_REQUESTED,
    NotificationType.CONTENT_RESUBMITTED,
    NotificationType.CONTENT_PUBLISHED,
    NotificationType.CONTENT_REVIEW_FAILED,
  ]);
  if (contentReviewEmailTypes.has(args.notificationType as NotificationType)) {
    const contentTitle =
      asTrimmedString(args.payload?.title) ||
      asTrimmedString(args.payload?.contentTitle) ||
      asTrimmedString(args.payload?.collectionTitle) ||
      asTrimmedString(args.payload?.productName) ||
      '';
    const detailedMessage =
      asTrimmedString(args.message) ||
      (contentTitle
        ? `Update for your content "${contentTitle}".`
        : 'Your content review status was updated.');
    const subjectTitle = contentTitle
      ? `"${contentTitle}"`
      : 'your content';
    const subjectVerb =
      args.notificationType === NotificationType.CONTENT_SUBMITTED_FOR_REVIEW
        ? 'submitted for review'
        : args.notificationType === NotificationType.CONTENT_REVIEW_APPROVED ||
            args.notificationType === NotificationType.CONTENT_PUBLISHED
          ? 'approved / live'
          : args.notificationType === NotificationType.CONTENT_REVIEW_REJECTED
            ? 'not approved'
            : args.notificationType === NotificationType.CONTENT_CHANGES_REQUESTED
              ? 'needs changes'
              : 'review update';
    const cta = renderNotificationCta(
      args.targetUrl,
      args.targetUrl
        ? getNotificationCtaLabel(args.notificationType, args.payload, args.targetUrl, companyName)
        : '',
    );
    const titleLine = contentTitle
      ? `<p style="margin:0 0 8px;font-size:16px;font-weight:700;color:${EMAIL_COLORS.textPrimary}">${escapeHtml(contentTitle)}</p>`
      : '';
    const html = renderEmailShell({
      appName: companyName,
      headerSubtitle: 'Content review',
      title: `Content ${subjectVerb}`,
      bodyHtml: `${titleLine}<p style="margin:0 0 10px;line-height:1.7;color:${EMAIL_COLORS.textSecondary}">${linkifyOrderReferences(escapeHtml(detailedMessage), args.targetUrl)}</p>${cta}`,
      footerContextText: `You are receiving this email because your ${companyName} account has content review notifications enabled.`,
    });
    return {
      subject: `${companyName}: ${subjectTitle} ${subjectVerb}`,
      html,
      text: [contentTitle, detailedMessage, args.targetUrl]
        .filter(Boolean)
        .join('\n\n'),
    };
  }

  const cta = renderNotificationCta(
    args.targetUrl,
    args.targetUrl
      ? getNotificationCtaLabel(args.notificationType, args.payload, args.targetUrl, companyName)
      : '',
  );

  const customOrderDetailTypes = new Set<NotificationType>([
    NotificationType.CUSTOM_ORDER_PAYMENT_RECEIVED,
    NotificationType.CUSTOM_ORDER_REVIEW_REQUIRED,
  ]);
  const detailRows = customOrderDetailTypes.has(
    args.notificationType as NotificationType,
  )
    ? buildCustomOrderEmailDetails(args.payload, args.targetUrl)
    : [];
  const detailTable = renderNotificationDetailsTable(detailRows);
  const subjectPrefix = getNotificationSubjectPrefix(args.notificationType);
  const displayHeading = subjectPrefix
    ? `${subjectPrefix} ${args.heading}`
    : args.heading;

  const html = renderEmailShell({
    appName: companyName,
    headerSubtitle: 'Account activity update',
    title: displayHeading,
    bodyHtml: `<p style="margin:0 0 10px;line-height:1.7;color:${EMAIL_COLORS.textSecondary}">${linkifyOrderReferences(escapeHtml(args.message), args.targetUrl)}</p>
      ${detailTable}
      ${cta}`,
    footerContextText: `You are receiving this email because your ${companyName} account has email notifications enabled.`,
  });

  const textParts = [args.heading, '', args.message];
  if (detailRows.length > 0) {
    textParts.push('', 'Details:');
    for (const detail of detailRows) {
      textParts.push(`- ${detail.label}: ${detail.value}`);
    }
  }
  if (args.targetUrl) {
    textParts.push(
      '',
      `${getNotificationCtaLabel(args.notificationType, args.payload, args.targetUrl, companyName)}: ${args.targetUrl}`,
    );
  }

  return {
    subject: `${subjectPrefix ? `${subjectPrefix} ` : ''}${companyName}: ${args.heading}`,
    html,
    text: textParts.join('\n'),
  };
}
