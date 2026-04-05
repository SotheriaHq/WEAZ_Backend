import { EmailContent } from './email.types';
import {
  EMAIL_COLORS,
  normalizeCompanyName,
  renderEmailButton,
  renderEmailShell,
} from './email.branding';

const BRAND_PRIMARY = EMAIL_COLORS.brandPrimary;
const BRAND_ACCENT = EMAIL_COLORS.brandAccent;
const TEXT_SECONDARY = EMAIL_COLORS.textSecondary;
const TEXT_MUTED = EMAIL_COLORS.textMuted;

function wrap(title: string, body: string, appName: string): string {
  return renderEmailShell({
    appName: normalizeCompanyName(appName),
    title,
    bodyHtml: body,
  });
}

function btn(href: string, label: string): string {
  return renderEmailButton(href, label);
}

export function passwordResetEmail(
  resetLink: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);

  return {
    subject: `Reset your ${companyName} password`,
    html: wrap(
      'Password Reset',
      `<p style="color:${TEXT_SECONDARY};line-height:1.7;margin:0 0 12px">We received a request to reset your ${companyName} password.</p>
      <p style="color:${TEXT_SECONDARY};line-height:1.7;margin:0 0 12px">Use the secure button below to choose a new password. For your protection, this link expires in 1 hour.</p>
      ${btn(resetLink, 'Reset Password')}
      <p style="color:${TEXT_MUTED};font-size:13px;line-height:1.6;margin:6px 0 0">If you did not request this, you can safely ignore this message. Your current password remains unchanged.</p>`,
      companyName,
    ),
    text: `Password Reset\n\nVisit this link to reset your password: ${resetLink}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
  };
}

export function emailVerificationEmail(
  verifyLink: string,
  appName: string,
): EmailContent {
  const companyName = normalizeCompanyName(appName);

  return {
    subject: `Verify your ${companyName} email`,
    html: wrap(
      'Confirm Your Email Address',
      `<p style="color:${TEXT_SECONDARY};line-height:1.7;margin:0 0 12px">Welcome to ${companyName}. To activate your account fully, please verify your email address through the secure link below.</p>
      <p style="color:${TEXT_SECONDARY};line-height:1.7;margin:0 0 12px">Once verified, you can complete your profile, connect with designers, and explore products from trusted brands across the ${companyName} community.</p>
      ${btn(verifyLink, 'Verify Email')}
      <p style="color:${TEXT_MUTED};font-size:13px;line-height:1.6;margin:6px 0 0">For your security, this verification link is single-use and will no longer work once your email is confirmed.</p>`,
      companyName,
    ),
    text: `Email Verification\n\nWelcome to ${companyName}. Verify your email address with this link: ${verifyLink}\n\nThis verification link is single-use and will no longer work after your email is confirmed.`,
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
      `<p style="color:#374151;line-height:1.6">A new daily break-glass code has been generated. Store this securely.</p>
      <div style="background:#fef2f2;border:2px solid ${BRAND_ACCENT};padding:16px;border-radius:8px;text-align:center;margin:16px 0">
        <span style="font-size:24px;font-weight:700;letter-spacing:4px;color:${BRAND_PRIMARY}">${code}</span>
      </div>
      <p style="color:#9ca3af;font-size:13px">This code is valid for 24 hours. Do not share it.</p>`,
      companyName,
    ),
    text: `BREAK-GLASS RECOVERY CODE\n\nCode: ${code}\n\nValid for 24 hours. Store securely. Do not share.`,
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
    subject: `Your ${companyName} admin account has been created`,
    html: wrap(
      'Admin Account Created',
      `<p style="color:#374151;line-height:1.6">An administrator account has been created for you.</p>
      <table style="width:100%;margin:16px 0;border-collapse:collapse">
        <tr><td style="padding:8px;color:#6b7280;border-bottom:1px solid #e5e7eb">Email</td><td style="padding:8px;font-weight:600;border-bottom:1px solid #e5e7eb">${email}</td></tr>
        <tr><td style="padding:8px;color:#6b7280;border-bottom:1px solid #e5e7eb">Temporary Password</td><td style="padding:8px;font-weight:600;font-family:monospace;border-bottom:1px solid #e5e7eb">${tempPassword}</td></tr>
      </table>
      <p style="color:#ef4444;font-weight:600">You must change your password on first login.</p>
      ${btn(loginUrl, 'Log In Now')}`,
      companyName,
    ),
    text: `Admin Account Created\n\nEmail: ${email}\nTemporary Password: ${tempPassword}\n\nYou must change your password on first login.\n\nLogin: ${loginUrl}`,
  };
}

export function brandVerificationApprovedEmail(
  brandName: string,
  appName: string,
): EmailContent {
  return {
    subject: `Your brand "${brandName}" has been verified!`,
    html: wrap(
      '✅ Brand Verified',
      `<p style="color:#374151;line-height:1.6">Congratulations! Your brand <strong>${brandName}</strong> has been verified. You can now open your store and start selling.</p>`,
      appName,
    ),
    text: `Brand Verified\n\nYour brand "${brandName}" has been verified. You can now open your store and start selling.`,
  };
}

export function verificationSubmittedEmail(
  brandName: string,
  appName: string,
): EmailContent {
  return {
    subject: `Verification submitted for "${brandName}"`,
    html: wrap(
      'Verification Submitted',
      `<p style="color:#374151;line-height:1.6">We received your verification application for <strong>${brandName}</strong>.</p>
      <p style="color:#374151;line-height:1.6">Our team will review it and notify you when the status changes.</p>`,
      appName,
    ),
    text: `Verification Submitted\n\nWe received your verification application for "${brandName}". We will notify you when the status changes.`,
  };
}

export function verificationInReviewEmail(
  brandName: string,
  appName: string,
): EmailContent {
  return {
    subject: `Verification review started for "${brandName}"`,
    html: wrap(
      'Verification In Review',
      `<p style="color:#374151;line-height:1.6">Your verification application for <strong>${brandName}</strong> is now being reviewed.</p>`,
      appName,
    ),
    text: `Verification In Review\n\nYour verification application for "${brandName}" is now being reviewed.`,
  };
}

export function verificationInfoRequestedEmail(
  brandName: string,
  requestedItems: string[],
  appName: string,
): EmailContent {
  const itemsMarkup = requestedItems.length
    ? `<ul style="color:#374151;line-height:1.6;padding-left:20px">${requestedItems
        .map((item) => `<li>${item}</li>`)
        .join('')}</ul>`
    : '';
  const itemsText = requestedItems.length
    ? requestedItems.map((item) => `- ${item}`).join('\n')
    : 'Please review your submitted verification details.';

  return {
    subject: `More verification information is needed for "${brandName}"`,
    html: wrap(
      'More Information Needed',
      `<p style="color:#374151;line-height:1.6">We need additional information to continue reviewing <strong>${brandName}</strong>.</p>${itemsMarkup}`,
      appName,
    ),
    text: `More Information Needed\n\nWe need additional information to continue reviewing "${brandName}".\n\n${itemsText}`,
  };
}

export function brandVerificationRejectedEmail(
  brandName: string,
  reason: string,
  appName: string,
): EmailContent {
  return {
    subject: `Brand verification update for "${brandName}"`,
    html: wrap(
      'Brand Verification Update',
      `<p style="color:#374151;line-height:1.6">We were unable to verify your brand <strong>${brandName}</strong> at this time.</p>
      <div style="background:#fef2f2;padding:16px;border-radius:8px;margin:16px 0">
        <p style="color:#991b1b;margin:0"><strong>Reason:</strong> ${reason}</p>
      </div>
      <p style="color:#374151">You can update your documents and resubmit for verification.</p>`,
      appName,
    ),
    text: `Brand Verification Update\n\nWe were unable to verify "${brandName}".\n\nReason: ${reason}\n\nYou can update your documents and resubmit.`,
  };
}

export function verificationCooldownExpiredEmail(
  brandName: string,
  appName: string,
): EmailContent {
  return {
    subject: `Verification is available again for "${brandName}"`,
    html: wrap(
      'Verification Available Again',
      `<p style="color:#374151;line-height:1.6">The verification cooldown for <strong>${brandName}</strong> has expired.</p>
      <p style="color:#374151;line-height:1.6">You can review your details and submit a new verification request whenever you are ready.</p>`,
      appName,
    ),
    text: `Verification Available Again\n\nThe verification cooldown for "${brandName}" has expired. You can submit a new verification request whenever you are ready.`,
  };
}

export function verificationNudgeEmail(
  brandName: string,
  appName: string,
): EmailContent {
  return {
    subject: `Complete verification for "${brandName}"`,
    html: wrap(
      'Build More Trust',
      `<p style="color:#374151;line-height:1.6">Your store <strong>${brandName}</strong> is live. Completing verification adds a stronger trust signal for shoppers.</p>
      <p style="color:#374151;line-height:1.6">You can start the verification flow from your studio whenever you are ready.</p>`,
      appName,
    ),
    text: `Build More Trust\n\nYour store "${brandName}" is live. Completing verification adds a stronger trust signal for shoppers. You can start the verification flow from your studio whenever you are ready.`,
  };
}

export function accountSuspendedEmail(
  firstName: string,
  reason: string,
  appName: string,
): EmailContent {
  return {
    subject: `Your ${appName} account has been suspended`,
    html: wrap(
      'Account Suspended',
      `<p style="color:#374151;line-height:1.6">Hi ${firstName}, your account has been suspended.</p>
      <div style="background:#fef2f2;padding:16px;border-radius:8px;margin:16px 0">
        <p style="color:#991b1b;margin:0"><strong>Reason:</strong> ${reason || 'Policy violation'}</p>
      </div>
      <p style="color:#374151">If you believe this is an error, you can submit a reactivation request.</p>`,
      appName,
    ),
    text: `Account Suspended\n\nHi ${firstName}, your account has been suspended.\nReason: ${reason || 'Policy violation'}\n\nYou can submit a reactivation request if you believe this is an error.`,
  };
}

export function accountReactivatedEmail(
  firstName: string,
  appName: string,
): EmailContent {
  return {
    subject: `Your ${appName} account has been reactivated`,
    html: wrap(
      'Account Reactivated',
      `<p style="color:#374151;line-height:1.6">Hi ${firstName}, your account has been reactivated. You can now log in and use all features.</p>`,
      appName,
    ),
    text: `Account Reactivated\n\nHi ${firstName}, your account has been reactivated. You can now log in.`,
  };
}

export function disputeResolvedEmail(
  disputeId: string,
  resolution: string,
  appName: string,
): EmailContent {
  return {
    subject: `Dispute #${disputeId.slice(0, 8)} has been resolved`,
    html: wrap(
      'Dispute Resolved',
      `<p style="color:#374151;line-height:1.6">A dispute you were involved in has been resolved.</p>
      <div style="background:#f0fdf4;padding:16px;border-radius:8px;margin:16px 0">
        <p style="color:#166534;margin:0"><strong>Resolution:</strong> ${resolution}</p>
      </div>`,
      appName,
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
  return {
    subject: `Payout ${status}: ${currency} ${amount}`,
    html: wrap(
      'Payout Update',
      `<p style="color:#374151;line-height:1.6">Your payout of <strong>${currency} ${amount}</strong> has been <strong>${status.toLowerCase()}</strong>.</p>`,
      appName,
    ),
    text: `Payout Update\n\nYour payout of ${currency} ${amount} has been ${status.toLowerCase()}.`,
  };
}
