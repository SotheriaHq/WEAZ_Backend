import { EmailPriority, NotificationType } from '@prisma/client';

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

export function renderNotificationEmail(args: {
  appName: string;
  heading: string;
  message: string;
  targetUrl?: string;
}): { subject: string; html: string; text: string } {
  const cta = args.targetUrl
    ? `<p style="margin:18px 0"><a href="${args.targetUrl}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#0f766e;color:#fff;text-decoration:none;font-weight:600">Open in ${args.appName}</a></p>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;padding:20px 12px">
    <tr>
      <td style="background:#111827;border-radius:12px 12px 0 0;padding:20px 24px;color:#fff;font-size:20px;font-weight:700">${args.appName}</td>
    </tr>
    <tr>
      <td style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none">
        <h1 style="margin:0 0 12px;font-size:20px;color:#111827">${args.heading}</h1>
        <p style="margin:0 0 8px;line-height:1.6;color:#374151">${args.message}</p>
        ${cta}
      </td>
    </tr>
    <tr>
      <td style="background:#f3f4f6;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:14px 24px;color:#6b7280;font-size:12px">
        You are receiving this email because your Threadly account has email notifications enabled.
      </td>
    </tr>
  </table>
</body>
</html>`;

  const textParts = [args.heading, '', args.message];
  if (args.targetUrl) {
    textParts.push('', `Open in ${args.appName}: ${args.targetUrl}`);
  }

  return {
    subject: `${args.appName}: ${args.heading}`,
    html,
    text: textParts.join('\n'),
  };
}
