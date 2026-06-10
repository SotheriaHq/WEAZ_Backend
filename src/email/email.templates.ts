import { EmailContent } from './email.types';
import {
  EMAIL_COLORS,
  escapeHtml,
  normalizeCompanyName,
  renderEmailButton,
  renderEmailShell,
  resolveAppUrl,
} from './email.branding';

const BRAND_PRIMARY = EMAIL_COLORS.brandPrimary;
const BRAND_ACCENT = EMAIL_COLORS.brandAccent;
const TEXT_SECONDARY = EMAIL_COLORS.textSecondary;
const TEXT_MUTED = EMAIL_COLORS.textMuted;

function wrap(
  title: string,
  body: string,
  appName: string,
  footerContext?: string,
): string {
  return renderEmailShell({
    appName: normalizeCompanyName(appName),
    title,
    bodyHtml: body,
    footerContextText: footerContext,
  });
}

function btn(href: string, label: string): string {
  return renderEmailButton(href, label);
}

const infoBox = (html: string) =>
  `<div style="background:#f5f3ff;border-left:4px solid ${BRAND_PRIMARY};border-radius:0 12px 12px 0;padding:14px 18px;margin:16px 0">${html}</div>`;

const successBox = (html: string) =>
  `<div style="background:#f0fdf4;border-left:4px solid #16a34a;border-radius:0 12px 12px 0;padding:14px 18px;margin:16px 0">${html}</div>`;

const warningBox = (html: string) =>
  `<div style="background:#fff7ed;border-left:4px solid #ea580c;border-radius:0 12px 12px 0;padding:14px 18px;margin:16px 0">${html}</div>`;

const errorBox = (html: string) =>
  `<div style="background:#fef2f2;border-left:4px solid #dc2626;border-radius:0 12px 12px 0;padding:14px 18px;margin:16px 0">${html}</div>`;

const p = (text: string) =>
  `<p style="color:${TEXT_SECONDARY};line-height:1.75;margin:0 0 14px;font-size:15px">${text}</p>`;

const muted = (text: string) =>
  `<p style="color:${TEXT_MUTED};font-size:13px;line-height:1.6;margin:6px 0 0">${text}</p>`;

const VERIFICATION_WORKSPACE_URL = resolveAppUrl('/studio/verification');

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────

export function passwordResetEmail(
  resetLink: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);

  return {
    subject: `Reset your ${companyName} password`,
    html: wrap(
      'Reset Your Password',
      `${p(`No worries — it happens to the best of us. We received a request to reset the password on your <strong>${companyName}</strong> account.`)}
      ${p('Click the button below to create a new password. The link is valid for <strong>1 hour</strong> and can only be used once.')}
      <div style="text-align:center;margin:24px 0">${btn(resetLink, 'Reset My Password')}</div>
      ${warningBox(`<p style="margin:0;color:#9a3412;font-size:13px">If you didn't request this, your account is safe — just ignore this email. Your current password remains unchanged.</p>`)}`,
      companyName,
    ),
    text: `Reset Your Password\n\nWe received a request to reset your ${companyName} password. Click the link below:\n\n${resetLink}\n\nThis link expires in 1 hour and is single-use. If you didn't request this, ignore this email.`,
  };
}

export function emailVerificationEmail(
  verifyLink: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);

  return {
    subject: `You're almost in — confirm your ${companyName} email`,
    html: wrap(
      'One Quick Step',
      `${p(`Welcome to <strong>${companyName}</strong> — Africa's fashion social commerce community. You're just one click away from unlocking your full workspace.`)}
      ${p('Verifying your email lets you create designs, connect with buyers, build your brand, and do so much more. It keeps your account secure too.')}
      <div style="text-align:center;margin:24px 0">${btn(verifyLink, 'Confirm My Email')}</div>
      ${infoBox(`<p style="margin:0;color:${BRAND_PRIMARY};font-size:13px">This link is single-use and stops working once your email is confirmed — so click it when you're ready to dive in.</p>`)}`,
      companyName,
      `This email was sent because someone signed up for a ${companyName} account with this address.`,
    ),
    text: `Welcome to ${companyName}!\n\nConfirm your email to unlock your full workspace:\n\n${verifyLink}\n\nThis link is single-use and expires after confirmation.`,
  };
}

export function emailLoginCodeEmail(
  code: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  const safeCode = escapeHtml(code);

  return {
    subject: `Your ${companyName} password setup code`,
    html: wrap(
      'Create Your Password',
      `${p(`Use this verification code to create a password for your <strong>${companyName}</strong> account.`)}
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:18px;text-align:center;margin:20px 0">
        <span style="font-size:28px;font-weight:700;letter-spacing:6px;color:${BRAND_PRIMARY};font-family:monospace">${safeCode}</span>
      </div>
      ${warningBox(`<p style="margin:0;color:#9a3412;font-size:13px">This code expires in <strong>10 minutes</strong> and can only be used once. If you didn't request it, ignore this email.</p>`)}`,
      companyName,
      `This email was sent because someone requested password setup for a Google-created ${companyName} account.`,
    ),
    text: `Create Your Password\n\nYour ${companyName} verification code is: ${code}\n\nThis code expires in 10 minutes and can only be used once. If you didn't request it, ignore this email.`,
  };
}

export function breakGlassCodeEmail(
  code: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);

  return {
    subject: `[URGENT] ${companyName} Break-Glass Recovery Code`,
    html: wrap(
      '🔑 Break-Glass Recovery Code',
      `<p style="color:#374151;line-height:1.6">A new daily break-glass code has been generated for ${companyName}. Store this securely — do not share it.</p>
      <div style="background:#fef2f2;border:2px solid ${BRAND_ACCENT};padding:16px;border-radius:8px;text-align:center;margin:16px 0">
        <span style="font-size:24px;font-weight:700;letter-spacing:4px;color:${BRAND_PRIMARY}">${code}</span>
      </div>
      <p style="color:#9ca3af;font-size:13px">Valid for 24 hours. Store in a secure password manager. Do not share or commit to any repository.</p>`,
      companyName,
    ),
    text: `BREAK-GLASS RECOVERY CODE\n\nCode: ${code}\n\nValid for 24 hours. Store securely. Do not share.`,
  };
}

export function breakGlassSuperAdminRecoveryEmail(args: {
  email: string;
  temporaryPassword: string;
  appName: string;
}): EmailContent {
  const companyName = normalizeCompanyName(args.appName);
  const safeEmail = escapeHtml(args.email);
  const safePassword = escapeHtml(args.temporaryPassword);

  return {
    subject: `[URGENT] ${companyName} SuperAdmin Recovery Credentials`,
    html: wrap(
      'SuperAdmin Recovery Completed',
      `${p(`Break-glass recovery created or reactivated a <strong>SuperAdmin</strong> account for <strong>${safeEmail}</strong>.`)}
      ${warningBox('<p style="margin:0;color:#9a3412;font-size:13px;font-weight:600">Use this temporary password only once. The account is flagged for mandatory password rotation on first sign-in.</p>')}
      <table style="width:100%;margin:16px 0;border-collapse:collapse;border-radius:12px;overflow:hidden">
        <tr style="background:#f9fafb"><td style="padding:12px 16px;color:#6b7280;font-size:14px;border-bottom:1px solid #e5e7eb">Email</td><td style="padding:12px 16px;font-weight:600;font-size:14px;border-bottom:1px solid #e5e7eb">${safeEmail}</td></tr>
        <tr><td style="padding:12px 16px;color:#6b7280;font-size:14px">Temporary Password</td><td style="padding:12px 16px;font-weight:600;font-family:monospace;font-size:15px;letter-spacing:1px">${safePassword}</td></tr>
      </table>
      ${p('This event has been written to the admin audit log. If you did not initiate this recovery, rotate platform secrets and investigate admin access immediately.')}`,
      companyName,
    ),
    text: `SuperAdmin recovery completed\n\nEmail: ${args.email}\nTemporary password: ${args.temporaryPassword}\n\nUse this password only once. The account must rotate the password on first sign-in. If you did not initiate this recovery, rotate platform secrets and investigate admin access immediately.`,
  };
}

export function adminAccountCreatedEmail(
  email: string,
  tempPassword: string,
  loginUrl: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);

  return {
    subject: `Your ${companyName} admin account is ready`,
    html: wrap(
      'Admin Account Created',
      `${p(`An administrator account has been set up for you on <strong>${companyName}</strong>. Here are your login credentials:`)}
      <table style="width:100%;margin:16px 0;border-collapse:collapse;border-radius:12px;overflow:hidden">
        <tr style="background:#f9fafb"><td style="padding:12px 16px;color:#6b7280;font-size:14px;border-bottom:1px solid #e5e7eb">Email</td><td style="padding:12px 16px;font-weight:600;font-size:14px;border-bottom:1px solid #e5e7eb">${email}</td></tr>
        <tr><td style="padding:12px 16px;color:#6b7280;font-size:14px">Temporary Password</td><td style="padding:12px 16px;font-weight:600;font-family:monospace;font-size:15px;letter-spacing:1px">${tempPassword}</td></tr>
      </table>
      ${warningBox(`<p style="margin:0;color:#9a3412;font-size:13px;font-weight:600">⚠️ You must change your password immediately on first login. Temporary credentials expire after 24 hours.</p>`)}
      <div style="text-align:center;margin:24px 0">${btn(loginUrl, 'Log In to Admin Console')}</div>`,
      companyName,
    ),
    text: `Admin Account Created\n\nEmail: ${email}\nTemporary Password: ${tempPassword}\n\nChange your password on first login. Link: ${loginUrl}`,
  };
}

export function brandStaffInviteEmail(args: {
  brandName: string;
  inviterDisplayName?: string | null;
  inviterEmail?: string | null;
  role: string;
  expiresAt: Date | string;
  inviteLink: string;
  appName: string;
}): EmailContent {
  const companyName = normalizeCompanyName(args.appName);
  const brandName = args.brandName || 'a brand';
  const roleLabel = args.role.replace(/_/g, ' ').toLowerCase();
  const inviterLabel =
    args.inviterDisplayName ||
    args.inviterEmail ||
    `A ${companyName} brand owner`;
  const expiresAt =
    args.expiresAt instanceof Date ? args.expiresAt : new Date(args.expiresAt);
  const expiryLabel = Number.isNaN(expiresAt.getTime())
    ? 'soon'
    : expiresAt.toLocaleString('en-NG', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });

  return {
    subject: `${brandName} invited you to join their ${companyName} workspace`,
    html: wrap(
      'Brand Staff Invitation',
      `${p(`${escapeHtml(inviterLabel)} invited you to join <strong>${escapeHtml(brandName)}</strong> on <strong>${companyName}</strong> as <strong>${escapeHtml(roleLabel)}</strong>.`)}
      ${p(`Use the button below to review and accept or reject this invitation. It expires on <strong>${escapeHtml(expiryLabel)}</strong>.`)}
      <div style="text-align:center;margin:24px 0">${btn(args.inviteLink, 'Review Invitation')}</div>
      ${warningBox(`<p style="margin:0;color:#9a3412;font-size:13px">Only accept this invite if you expected access to this brand workspace. If this looks unfamiliar, reject it or ignore this email.</p>`)}`,
      companyName,
      `This email was sent because a ${companyName} brand owner invited this address to a brand workspace.`,
    ),
    text: `Brand Staff Invitation\n\n${inviterLabel} invited you to join ${brandName} on ${companyName} as ${args.role}.\n\nReview the invitation here:\n${args.inviteLink}\n\nThis invite expires on ${expiryLabel}. Only accept if expected.`,
  };
}

// ─────────────────────────────────────────────
// BRAND VERIFICATION
// ─────────────────────────────────────────────

export function brandVerificationApprovedEmail(
  brandName: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  return {
    subject: `🎉 "${brandName}" is now a verified brand on ${companyName}!`,
    html: wrap(
      "You're Verified!",
      `${successBox(`<p style="margin:0;color:#166534;font-size:15px;font-weight:600">🎉 Congratulations — <strong>${brandName}</strong> is now verified on ${companyName}!</p>`)}
      ${p(`Your verified badge is now live on your public brand profile. Buyers notice it — it signals trust, authenticity, and that you mean business.`)}
      ${p(`Here is what unlocks for verified brands:`)}
      <ul style="color:${TEXT_SECONDARY};line-height:1.9;padding-left:22px;margin:0 0 16px;font-size:14px">
        <li>✅ Verified badge on your profile and designs</li>
        <li>✅ Priority placement in search results</li>
        <li>✅ Access to premium promotional tools</li>
        <li>✅ Higher buyer confidence and conversion</li>
      </ul>
      <div style="text-align:center;margin:24px 0">${btn(VERIFICATION_WORKSPACE_URL, 'View My Verified Profile')}</div>`,
      companyName,
    ),
    text: `Congratulations! "${brandName}" is now verified on ${companyName}.\n\nYour verified badge is live. View it here: ${VERIFICATION_WORKSPACE_URL}`,
  };
}

export function verificationSubmittedEmail(
  brandName: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  return {
    subject: `We've received your verification request for "${brandName}"`,
    html: wrap(
      'Verification Submitted',
      `${infoBox(`<p style="margin:0;color:${BRAND_PRIMARY};font-size:14px">📥 Your verification request for <strong>${brandName}</strong> is in our review queue.</p>`)}
      ${p(`Our team reviews each brand manually to maintain the trust and quality that ${companyName} buyers expect. Here's what happens next:`)}
      <ul style="color:${TEXT_SECONDARY};line-height:1.9;padding-left:22px;margin:0 0 16px;font-size:14px">
        <li>🔍 Our team reviews your brand details and documents</li>
        <li>📞 We may reach out if we need additional information</li>
        <li>✅ Most requests are resolved within <strong>1–3 business days</strong></li>
        <li>📧 You'll get an email the moment a decision is made</li>
      </ul>
      <div style="text-align:center;margin:24px 0">${btn(VERIFICATION_WORKSPACE_URL, 'Track My Verification')}</div>
      ${muted("While you wait, keep creating and publishing designs. Verified status applies to everything you've built.")}`,
      companyName,
    ),
    text: `Verification Submitted for "${brandName}"\n\nYour request is in our review queue. Most reviews complete in 1–3 business days. Track it here: ${VERIFICATION_WORKSPACE_URL}`,
  };
}

export function verificationInReviewEmail(
  brandName: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  return {
    subject: `Your "${brandName}" verification is actively being reviewed`,
    html: wrap(
      'Under Review',
      `${infoBox(`<p style="margin:0;color:${BRAND_PRIMARY};font-size:14px">👀 A reviewer has picked up the verification request for <strong>${brandName}</strong>.</p>`)}
      ${p(`No action is needed from your side right now. Our team is reviewing your brand profile, documents, and contact information.`)}
      ${p(`If we need anything else, we'll reach out directly. Otherwise, you'll hear from us soon with a decision.`)}
      <div style="text-align:center;margin:24px 0">${btn(VERIFICATION_WORKSPACE_URL, 'Check Verification Status')}</div>`,
      companyName,
    ),
    text: `"${brandName}" verification is now under active review.\n\nNo action needed — you'll hear from us soon. Check status: ${VERIFICATION_WORKSPACE_URL}`,
  };
}

export function verificationInfoRequestedEmail(
  brandName: string,
  requestedItems: string[],
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  const itemsMarkup = requestedItems.length
    ? `<ul style="color:${TEXT_SECONDARY};line-height:1.9;padding-left:22px;margin:8px 0 16px;font-size:14px">${requestedItems
        .map((item) => `<li>📎 ${item}</li>`)
        .join('')}</ul>`
    : '';
  const itemsText = requestedItems.length
    ? requestedItems.map((item) => `- ${item}`).join('\n')
    : 'Please review your submitted verification details.';

  return {
    subject: `Action needed: Additional info required for "${brandName}"`,
    html: wrap(
      'A Little More Info Needed',
      `${warningBox(`<p style="margin:0;color:#9a3412;font-size:14px">📋 We need a bit more information to complete the review for <strong>${brandName}</strong>.</p>`)}
      ${p(`Here's exactly what we need from you:`)}
      ${itemsMarkup}
      ${p(`Providing complete, accurate information speeds up your review. Head to the verification workspace to make the updates.`)}
      <div style="text-align:center;margin:24px 0">${btn(VERIFICATION_WORKSPACE_URL, 'Submit Requested Info')}</div>
      ${muted("Once you've submitted the updates, our team will continue the review without delay.")}`,
      companyName,
    ),
    text: `Action Needed: Additional info for "${brandName}"\n\n${itemsText}\n\nSubmit updates here: ${VERIFICATION_WORKSPACE_URL}`,
  };
}

export function brandVerificationRejectedEmail(
  brandName: string,
  reason: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  return {
    subject: `Verification update for "${brandName}" — next steps inside`,
    html: wrap(
      'Verification Not Approved',
      `${p(`Thank you for applying for brand verification on ${companyName}. After reviewing <strong>${brandName}</strong>, we were unable to approve the request at this time.`)}
      ${errorBox(`<p style="color:#991b1b;margin:0;font-size:14px;line-height:1.6"><strong>Reason:</strong> ${reason}</p>`)}
      ${p(`This isn't the end of the road. Here's how to move forward:`)}
      <ul style="color:${TEXT_SECONDARY};line-height:1.9;padding-left:22px;margin:0 0 16px;font-size:14px">
        <li>📖 Review the feedback carefully</li>
        <li>✏️ Update the missing or unclear details on your brand profile</li>
        <li>📤 Resubmit when you're ready — there's no penalty for reapplying</li>
      </ul>
      <div style="text-align:center;margin:24px 0">${btn(VERIFICATION_WORKSPACE_URL, 'Review Feedback & Resubmit')}</div>
      ${muted(`Many brands are approved on their second attempt after addressing the feedback. We look forward to your next submission.`)}`,
      companyName,
    ),
    text: `Verification Update for "${brandName}"\n\nReason: ${reason}\n\nReview feedback and resubmit: ${VERIFICATION_WORKSPACE_URL}`,
  };
}

export function verificationCooldownExpiredEmail(
  brandName: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  return {
    subject: `You can re-apply for verification — "${brandName}" is ready`,
    html: wrap(
      'Ready to Reapply',
      `${successBox(`<p style="margin:0;color:#166534;font-size:14px">✅ The verification cooldown for <strong>${brandName}</strong> has expired — you can submit a new request.</p>`)}
      ${p(`Take a moment to review your brand profile before reapplying. Make sure your brand name, logo, category, and any documents are complete and accurate.`)}
      ${p(`Strong applications are specific: clear photos, a consistent brand story, and a real contact presence. The more we can verify, the faster we can approve.`)}
      <div style="text-align:center;margin:24px 0">${btn(VERIFICATION_WORKSPACE_URL, 'Start a New Application')}</div>`,
      companyName,
    ),
    text: `"${brandName}" can now re-apply for verification.\n\nStart a new application: ${VERIFICATION_WORKSPACE_URL}`,
  };
}

export function verificationNudgeEmail(
  brandName: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  return {
    subject: `Build more trust — get "${brandName}" verified on ${companyName}`,
    html: wrap(
      'Your Brand is Live. Make It Shine.',
      `${p(`<strong>${brandName}</strong> is live on ${companyName}. That's a great start — but verified brands consistently sell more, get more followers, and stand out in the market.`)}
      ${infoBox(`<p style="margin:0;color:${BRAND_PRIMARY};font-size:14px;font-weight:600">Verified brands see up to 3× more buyer engagement than unverified ones.</p>`)}
      ${p(`What you unlock with verification:`)}
      <ul style="color:${TEXT_SECONDARY};line-height:1.9;padding-left:22px;margin:0 0 16px;font-size:14px">
        <li>🏅 Verified badge on your profile, designs, and products</li>
        <li>📈 Priority placement in search and explore results</li>
        <li>🛡️ Buyer confidence that converts to real sales</li>
        <li>🌟 Access to promotional and featured placement opportunities</li>
      </ul>
      ${p(`The process takes just a few minutes. We typically review within 1–3 business days.`)}
      <div style="text-align:center;margin:24px 0">${btn(VERIFICATION_WORKSPACE_URL, 'Start Verification Now')}</div>`,
      companyName,
    ),
    text: `Get "${brandName}" verified on ${companyName} and unlock more visibility.\n\nStart here: ${VERIFICATION_WORKSPACE_URL}`,
  };
}

// ─────────────────────────────────────────────
// ACCOUNT
// ─────────────────────────────────────────────

export function accountSuspendedEmail(
  firstName: string,
  reason: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  return {
    subject: `Important: Your ${companyName} account has been suspended`,
    html: wrap(
      'Account Suspended',
      `${p(`Hi ${firstName}, we're reaching out regarding your ${companyName} account.`)}
      ${errorBox(`<p style="color:#991b1b;margin:0;font-size:14px;line-height:1.6"><strong>Reason for suspension:</strong> ${reason || 'Policy violation'}</p>`)}
      ${p(`We take community safety seriously. If you believe this decision was made in error, you can submit a reactivation request — our team will review it within 48 hours.`)}
      ${muted(`Your data is preserved during suspension. Approved reactivations restore full access.`)}`,
      companyName,
    ),
    text: `Account Suspended\n\nHi ${firstName}, your ${companyName} account has been suspended.\nReason: ${reason || 'Policy violation'}\n\nSubmit a reactivation request if you believe this is an error.`,
  };
}

export function accountReactivatedEmail(
  firstName: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  return {
    subject: `Welcome back, ${firstName} — your ${companyName} account is active again`,
    html: wrap(
      "You're Back!",
      `${successBox(`<p style="margin:0;color:#166534;font-size:15px;font-weight:600">✅ Your ${companyName} account has been fully reactivated, ${firstName}.</p>`)}
      ${p(`Everything is exactly as you left it — your designs, products, orders, and followers are all still there.`)}
      ${p(`We're glad to have you back. If you have any questions or need help getting back up to speed, reply to this email and our team will assist you right away.`)}
      <div style="text-align:center;margin:24px 0">${btn(resolveAppUrl('/'), `Back to ${companyName}`)}</div>`,
      companyName,
    ),
    text: `Welcome back, ${firstName}! Your ${companyName} account has been reactivated. Everything is as you left it.`,
  };
}

export function confirmEmailChangeEmail(
  confirmLink: string,
  newEmail: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  return {
    subject: `Confirm your new ${companyName} email address`,
    html: wrap(
      'Confirm Email Change',
      `${p(`We received a request to change the email address on your <strong>${companyName}</strong> account to <strong>${newEmail}</strong>.`)}
      ${p('Click the button below to confirm the new email address. Your current email stays active until you complete this confirmation.')}
      <div style="text-align:center;margin:24px 0">${btn(confirmLink, 'Confirm New Email')}</div>
      ${warningBox('<p style="margin:0;color:#9a3412;font-size:13px">If you did not request this change, you can ignore this email and your account email will remain unchanged.</p>')}`,
      companyName,
    ),
    text: `Confirm your new ${companyName} email address\n\nConfirm this email change: ${confirmLink}\n\nIf you did not request it, ignore this email.`,
  };
}

export function passwordChangedSecurityAlertEmail(
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  return {
    subject: `${companyName} security alert: your password was changed`,
    html: wrap(
      'Password Changed',
      `${successBox('<p style="margin:0;color:#166534;font-size:14px;font-weight:600">Your password was updated successfully.</p>')}
      ${p("If this was you, no further action is needed. If this wasn't you, secure your account immediately by resetting your password and reviewing recent sessions.")}
      <div style="text-align:center;margin:24px 0">${btn(resolveAppUrl('/settings?tab=account-security'), 'Review Account Security')}</div>`,
      companyName,
    ),
    text: `Your ${companyName} password was changed.\n\nIf this wasn't you, secure your account immediately: ${resolveAppUrl('/settings?tab=account-security')}`,
  };
}

export function emailChangedSecurityAlertEmail(
  previousEmail: string,
  newEmail: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  return {
    subject: `${companyName} security alert: your email address was changed`,
    html: wrap(
      'Email Address Changed',
      `${infoBox(`<p style="margin:0;color:${BRAND_PRIMARY};font-size:14px">Your account email was changed from <strong>${previousEmail}</strong> to <strong>${newEmail}</strong>.</p>`)}
      ${p("If this was you, you're all set. If this wasn't you, secure your account immediately and contact support.")}`,
      companyName,
    ),
    text: `Your ${companyName} account email changed from ${previousEmail} to ${newEmail}. If this wasn't you, secure your account immediately.`,
  };
}

// ─────────────────────────────────────────────
// CONTENT
// ─────────────────────────────────────────────

export function collectionPublishedEmail(
  brandName: string,
  designTitle: string,
  designUrl: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);

  return {
    subject: `🎨 "${designTitle}" is live on ${companyName}!`,
    html: wrap(
      'Your Design is Live!',
      `${successBox(`<p style="margin:0;color:#166534;font-size:15px;font-weight:600">🎨 <strong>${designTitle}</strong> is now published and visible to the ${companyName} community!</p>`)}
      ${p(`<strong>${brandName}</strong>, your design is out in the world. Buyers, followers, and fashion lovers can now discover it, save it, comment, and place custom orders.`)}
      ${p(`Here's how to maximise its reach:`)}
      <ul style="color:${TEXT_SECONDARY};line-height:1.9;padding-left:22px;margin:0 0 16px;font-size:14px">
        <li>📲 Share the design link on your socials and stories</li>
        <li>🏷️ Make sure tags and categories are set — they power search</li>
        <li>💬 Engage with early comments to build momentum</li>
        <li>📸 Add more media angles if you have them — designs with more images get more saves</li>
      </ul>
      <div style="text-align:center;margin:24px 0">${btn(designUrl, 'View My Live Design')}</div>
      ${muted(`Keep creating — brands that publish consistently get significantly more reach on ${companyName}.`)}`,
      companyName,
      `This notification was sent because you published a design on your ${companyName} brand account.`,
    ),
    text: `"${designTitle}" is now live on ${companyName}!\n\nGreat work, ${brandName}. View your design here:\n${designUrl}`,
  };
}

// ─────────────────────────────────────────────
// ORDERS & FINANCE
// ─────────────────────────────────────────────

export function disputeResolvedEmail(
  disputeId: string,
  resolution: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  return {
    subject: `Dispute #${disputeId.slice(0, 8)} has been resolved`,
    html: wrap(
      'Dispute Resolved',
      `${p(`A dispute you were involved in on ${companyName} has been closed and a resolution has been reached.`)}
      ${successBox(`<p style="color:#166534;margin:0;font-size:14px;line-height:1.6"><strong>Resolution:</strong> ${resolution}</p>`)}
      ${p(`If you have questions about this outcome or believe the decision needs review, please reply to this email — our team is here to help.`)}`,
      companyName,
    ),
    text: `Dispute Resolved\n\nDispute #${disputeId.slice(0, 8)} has been resolved.\nResolution: ${resolution}`,
  };
}

export function payoutProcessedEmail(
  amount: string,
  currency: string,
  status: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  const isSuccess =
    status.toLowerCase() === 'processed' || status.toLowerCase() === 'success';

  return {
    subject: isSuccess
      ? `💸 Your ${companyName} payout of ${currency} ${amount} is on the way!`
      : `Payout update: ${currency} ${amount} — ${status}`,
    html: wrap(
      isSuccess ? 'Payout Sent!' : 'Payout Update',
      isSuccess
        ? `${successBox(`<p style="margin:0;color:#166534;font-size:15px;font-weight:600">💸 ${currency} ${amount} is on its way to your account!</p>`)}
          ${p(`Your payout has been processed and is headed to your registered payout account. Depending on your bank, funds typically arrive within <strong>1–3 business days</strong>.`)}
          ${p(`Keep building, keep selling — every order gets you closer to the next payout.`)}
          <div style="text-align:center;margin:24px 0">${btn(resolveAppUrl('/store/payouts'), 'View Payout History')}</div>`
        : `${p(`Your payout of <strong>${currency} ${amount}</strong> has a status update: <strong>${status}</strong>.`)}
          ${infoBox(`<p style="margin:0;color:${BRAND_PRIMARY};font-size:13px">If you have questions about this payout, check your payout history or contact support.</p>`)}
          <div style="text-align:center;margin:24px 0">${btn(resolveAppUrl('/store/payouts'), 'View Payout Details')}</div>`,
      companyName,
    ),
    text: `Payout Update\n\n${currency} ${amount} — ${status}.\n\nView payout history: ${resolveAppUrl('/store/payouts')}`,
  };
}

// ─────────────────────────────────────────────
// ADMIN EMAIL CHANGE WORKFLOW
// ─────────────────────────────────────────────

export function adminEmailChangeOtpEmail(
  otp: string,
  newEmail: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  return {
    subject: `Your ${companyName} admin email verification code`,
    html: wrap(
      'Admin Email Verification',
      `${p(`You requested an email address change on your <strong>${companyName}</strong> admin account. Use the code below to verify ownership of <strong>${escapeHtml(newEmail)}</strong>.`)}
      <div style="text-align:center;margin:28px 0">
        <div style="display:inline-block;background:#f5f3ff;border:2px dashed ${BRAND_PRIMARY};border-radius:12px;padding:18px 36px">
          <span style="font-size:36px;font-weight:700;letter-spacing:10px;color:${BRAND_PRIMARY};font-family:monospace">${otp}</span>
        </div>
        <p style="color:${TEXT_MUTED};font-size:13px;margin:10px 0 0">Expires in 10 minutes · Single use</p>
      </div>
      ${warningBox(`<p style="margin:0;color:#9a3412;font-size:13px">If you did not request this, someone may be attempting to change your admin email. Do not share this code.</p>`)}`,
      companyName,
    ),
    text: `Admin Email Verification\n\nYour verification code: ${otp}\n\nThis code expires in 10 minutes. Do not share it.`,
  };
}

export function adminEmailChangeApprovedEmail(
  newEmail: string,
  oldEmail: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  return {
    subject: `Your ${companyName} admin email has been updated`,
    html: wrap(
      'Email Address Updated',
      `${p(`Your admin account email address has been successfully updated.`)}
      ${infoBox(`<p style="margin:0;color:${BRAND_PRIMARY};font-size:14px">
        <strong>Previous email:</strong> ${escapeHtml(oldEmail)}<br>
        <strong>New email:</strong> ${escapeHtml(newEmail)}
      </p>`)}
      ${p(`You will now log in using <strong>${escapeHtml(newEmail)}</strong>. This email is your new contact address for all admin communications.`)}
      ${warningBox(`<p style="margin:0;color:#9a3412;font-size:13px">If you did not authorise this change, contact a Super Admin immediately.</p>`)}`,
      companyName,
    ),
    text: `Email Address Updated\n\nYour admin account email has been updated.\nPrevious: ${oldEmail}\nNew: ${newEmail}\n\nIf you did not authorise this, contact a Super Admin immediately.`,
  };
}

export function adminEmailChangeRejectedEmail(
  requestedEmail: string,
  reason: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);
  return {
    subject: `Your ${companyName} email change request was not approved`,
    html: wrap(
      'Email Change Request Rejected',
      `${p(`Your request to update your admin account email to <strong>${escapeHtml(requestedEmail)}</strong> was reviewed and not approved.`)}
      ${reason ? errorBox(`<p style="margin:0;color:#991b1b;font-size:14px"><strong>Reason:</strong> ${escapeHtml(reason)}</p>`) : ''}
      ${p(`If you believe this is an error or need further assistance, please contact your Super Admin.`)}`,
      companyName,
    ),
    text: `Email Change Request Rejected\n\nYour request to change your admin email to ${requestedEmail} was not approved.${reason ? `\n\nReason: ${reason}` : ''}\n\nContact your Super Admin for assistance.`,
  };
}
