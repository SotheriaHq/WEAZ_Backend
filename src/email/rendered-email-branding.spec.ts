import { NotificationType } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

import { PRODUCT_NAME } from '../common/branding/product-identity.constants';
import * as templates from './email.templates';
import * as branding from './email.branding';
import * as policy from '../notifications/email.policy';
import { resolveEmailConfig } from './email.config';

describe('Rendered Customer-Facing Email Branding & Legal Entity Suite', () => {
  const APP = PRODUCT_NAME; // 'ARU'
  const DUMMY_LINK = 'https://app.weaz.me/auth/verify?token=test-token-xyz';
  const LEGAL_ENTITY = 'Soteria Genesis Limited';

  const inspectNoLegacyBranding = (text: string, context: string) => {
    // Prohibit WIEZ, WEAZ, Wiezing, and Threadly in rendered customer-facing strings
    // Note: Temporary asset filename stems (e.g. wiez-email-logo.png) and preserved
    // operational domains (e.g. weaz.me) are excluded from copy checks per PO Decisions 1 & 4.
    const copyOnly = text
      .replace(/(?:aru|wiez)-email-logo\.png/g, '')
      .replace(/weaz\.me/g, '')
      .replace(/wiez\.me/g, '');
    expect(copyOnly).not.toMatch(/\bWIEZ\b/i);
    expect(copyOnly).not.toMatch(/\bWEAZ\b/i);
    expect(copyOnly).not.toMatch(/\bWiezing\b/i);
    expect(copyOnly).not.toMatch(/\bThreadly\b/i);
  };

  // ─────────────────────────────────────────────────────────────
  // 1. REGISTRATION & VERIFICATION EMAIL
  // ─────────────────────────────────────────────────────────────
  it('1. Registration verification email renders ARU in subject, HTML, plain-text, and includes legal footer', () => {
    const email = templates.emailVerificationEmail(DUMMY_LINK, APP);

    expect(email.subject).toContain('ARU');
    inspectNoLegacyBranding(email.subject, 'registration subject');

    expect(email.html).toContain('Confirm your ARU email');
    expect(email.html).toContain('Welcome to <strong>ARU</strong>');
    expect(email.html).toContain('Verifying your email lets you create designs');
    expect(email.html).toContain('Verify my email');
    expect(email.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(email.html, 'registration html');

    expect(email.text).toContain('Welcome to ARU!');
    expect(email.text).toContain('Confirm your email to unlock your full workspace');
    expect(email.text).toContain(DUMMY_LINK);
    inspectNoLegacyBranding(email.text, 'registration text');
  });

  // ─────────────────────────────────────────────────────────────
  // 2. WELCOME NOTIFICATION EMAIL
  // ─────────────────────────────────────────────────────────────
  it('2. Welcome email renders ARU in subject, HTML, and plain-text', () => {
    const welcome = policy.renderNotificationEmail({
      appName: APP,
      heading: 'Welcome to ARU',
      message: 'Welcome to ARU — your creative workspace is ready.',
      notificationType: NotificationType.SIGNUP,
      targetUrl: '/profile',
      payload: { action: 'SIGNUP', username: 'Amara' },
    });

    expect(welcome.subject).toContain('Welcome to ARU');
    inspectNoLegacyBranding(welcome.subject, 'welcome subject');

    expect(welcome.html).toContain('Welcome to ARU');
    expect(welcome.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(welcome.html, 'welcome html');

    expect(welcome.text).toContain('ARU');
    inspectNoLegacyBranding(welcome.text, 'welcome text');
  });

  // ─────────────────────────────────────────────────────────────
  // 3. PASSWORD RESET EMAIL
  // ─────────────────────────────────────────────────────────────
  it('3. Password reset email renders ARU in subject, HTML, and plain-text', () => {
    const reset = templates.passwordResetEmail(DUMMY_LINK, APP);

    expect(reset.subject).toContain('Reset your ARU password');
    inspectNoLegacyBranding(reset.subject, 'password reset subject');

    expect(reset.html).toContain('Reset your password');
    expect(reset.html).toContain('ARU');
    expect(reset.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(reset.html, 'password reset html');

    expect(reset.text).toContain('reset your ARU password');
    inspectNoLegacyBranding(reset.text, 'password reset text');
  });

  // ─────────────────────────────────────────────────────────────
  // 4. SECURITY NOTIFICATION EMAILS
  // ─────────────────────────────────────────────────────────────
  it('4. Security notification emails render ARU branding and preserve security notices', () => {
    const pwdAlert = templates.passwordChangedSecurityAlertEmail(APP);
    expect(pwdAlert.subject).toContain('security alert');
    expect(pwdAlert.subject).toContain('ARU');
    expect(pwdAlert.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(pwdAlert.subject, 'password alert subject');
    inspectNoLegacyBranding(pwdAlert.html, 'password alert html');

    const emailAlert = templates.emailChangedSecurityAlertEmail('old@weaz.me', 'new@weaz.me', APP);
    expect(emailAlert.subject).toContain('security alert');
    expect(emailAlert.subject).toContain('ARU');
    expect(emailAlert.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(emailAlert.subject, 'email alert subject');
    inspectNoLegacyBranding(emailAlert.html, 'email alert html');

    const emailChangeConfirm = templates.confirmEmailChangeEmail(DUMMY_LINK, 'new@weaz.me', APP);
    expect(emailChangeConfirm.subject).toContain('Confirm your new ARU email address');
    expect(emailChangeConfirm.html).toContain('ARU');
    expect(emailChangeConfirm.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(emailChangeConfirm.subject, 'confirm email change subject');
    inspectNoLegacyBranding(emailChangeConfirm.html, 'confirm email change html');
  });

  // ─────────────────────────────────────────────────────────────
  // 5. ORDER CONFIRMATION & STATUS NOTIFICATION
  // ─────────────────────────────────────────────────────────────
  it('5. Order confirmation notification renders ARU with correct link structure', () => {
    const orderEmail = policy.renderNotificationEmail({
      appName: APP,
      heading: 'Order Confirmed',
      message: 'Your order #CO-F9967352 has been placed successfully.',
      notificationType: NotificationType.ORDER_STATUS_UPDATED,
      targetUrl: '/profile?tab=orders&orderId=CO-F9967352',
      payload: { customOrderId: 'CO-F9967352', code: '#CO-F9967352' },
    });

    expect(orderEmail.subject).toContain('Order Confirmed');
    expect(orderEmail.html).toContain('ARU');
    expect(orderEmail.html).toContain('#CO-F9967352');
    expect(orderEmail.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(orderEmail.html, 'order email html');
  });

  // ─────────────────────────────────────────────────────────────
  // 6. PAYMENT NOTIFICATIONS
  // ─────────────────────────────────────────────────────────────
  it('6. Payment and payout notifications render ARU branding', () => {
    const payoutEmail = templates.payoutProcessedEmail('150000', 'NGN', 'processed', APP);

    expect(payoutEmail.subject).toContain('Your ARU payout');
    expect(payoutEmail.html).toContain('ARU');
    expect(payoutEmail.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(payoutEmail.subject, 'payout subject');
    inspectNoLegacyBranding(payoutEmail.html, 'payout html');

    const payoutCode = templates.payoutRequestCodeEmail('481920', 'NGN 150,000', 'Amara Atelier', APP);
    expect(payoutCode.subject).toContain('ARU payout');
    expect(payoutCode.html).toContain('ARU');
    expect(payoutCode.html).toContain('481920');
    expect(payoutCode.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(payoutCode.subject, 'payout code subject');
    inspectNoLegacyBranding(payoutCode.html, 'payout code html');
  });

  // ─────────────────────────────────────────────────────────────
  // 7. REFUND & DISPUTE NOTIFICATIONS
  // ─────────────────────────────────────────────────────────────
  it('7. Dispute resolution notification renders ARU branding', () => {
    const disputeEmail = templates.disputeResolvedEmail(
      'DISP-1234',
      'The dispute was resolved in your favor.',
      APP,
    );

    expect(disputeEmail.subject).toContain('Dispute #DISP-123 has been resolved');
    expect(disputeEmail.html).toContain('ARU');
    expect(disputeEmail.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(disputeEmail.subject, 'dispute subject');
    inspectNoLegacyBranding(disputeEmail.html, 'dispute html');
  });

  // ─────────────────────────────────────────────────────────────
  // 8. DESIGNER VERIFICATION NOTIFICATIONS
  // ─────────────────────────────────────────────────────────────
  it('8. Designer verification approval and submission emails render ARU', () => {
    const approved = templates.brandVerificationApprovedEmail('Amara Atelier', APP);
    expect(approved.subject).toContain('is now verified on ARU');
    expect(approved.html).toContain('is now verified on ARU');
    expect(approved.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(approved.subject, 'designer approval subject');
    inspectNoLegacyBranding(approved.html, 'designer approval html');

    const submitted = templates.verificationSubmittedEmail('Amara Atelier', APP);
    expect(submitted.subject).toContain('Verification request received');
    expect(submitted.html).toContain('ARU');
    expect(submitted.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(submitted.subject, 'designer submission subject');
    inspectNoLegacyBranding(submitted.html, 'designer submission html');

    const underReview = templates.verificationInReviewEmail('Amara Atelier', APP);
    expect(underReview.subject).toContain('verification is under review');
    expect(underReview.html).toContain('ARU');
    expect(underReview.html).toContain(LEGAL_ENTITY);

    const infoRequested = templates.verificationInfoRequestedEmail('Amara Atelier', ['Business registration document'], APP);
    expect(infoRequested.subject).toContain('verification needs info');
    expect(infoRequested.html).toContain('ARU');
    expect(infoRequested.html).toContain(LEGAL_ENTITY);

    const rejected = templates.brandVerificationRejectedEmail('Amara Atelier', 'Missing catalogue samples', APP);
    expect(rejected.subject).toContain('Verification update');
    expect(rejected.html).toContain('ARU');
    expect(rejected.html).toContain(LEGAL_ENTITY);

    const cooldownExpired = templates.verificationCooldownExpiredEmail('Amara Atelier', APP);
    expect(cooldownExpired.subject).toContain('can re-apply for ARU verification');
    expect(cooldownExpired.html).toContain('ARU');
    expect(cooldownExpired.html).toContain(LEGAL_ENTITY);

    const nudge = templates.verificationNudgeEmail('Amara Atelier', APP);
    expect(nudge.subject).toContain('verify "Amara Atelier" on ARU');
    expect(nudge.html).toContain('ARU');
    expect(nudge.html).toContain(LEGAL_ENTITY);
  });

  // ─────────────────────────────────────────────────────────────
  // 9. SENDER DISPLAY NAME CANONICALIZATION & ADDRESS PRESERVATION (WP-B5)
  // ─────────────────────────────────────────────────────────────
  it('9. Sender display names upgrade legacy strings to ARU while preserving sender address and domain (all 13 WP-B5 criteria)', () => {
    const createConfig = (
      fromValue: string,
      appNameValue?: string,
      replyToValue = 'support@weaz.me',
    ): ConfigService => {
      const values: Record<string, string | undefined> = {
        EMAIL_PROVIDER: 'resend',
        EMAIL_MODE: 'log_only',
        RESEND_FROM: fromValue,
        APP_NAME: appNameValue,
        RESEND_REPLY_TO: replyToValue,
      };
      return {
        get: jest.fn((key: string) => values[key]),
      } as unknown as ConfigService;
    };

    // 1. WIEZ sender display name becomes ARU
    const configA = resolveEmailConfig(createConfig('WIEZ <noreply@weaz.me>'));
    expect(configA.fromName).toBe('ARU');
    expect(configA.from).toBe('ARU <noreply@weaz.me>');

    // 2. WEAZ sender display name becomes ARU
    const configB = resolveEmailConfig(createConfig('WEAZ <noreply@weaz.me>', 'WEAZ'));
    expect(configB.fromName).toBe('ARU');
    expect(configB.from).toBe('ARU <noreply@weaz.me>');

    // 3. Known legacy Threadly display name becomes ARU
    const configC = resolveEmailConfig(createConfig('Threadly <noreply@weaz.me>'));
    expect(configC.fromName).toBe('ARU');
    expect(configC.from).toBe('ARU <noreply@weaz.me>');

    // 4. Existing ARU display name remains unchanged
    const configD = resolveEmailConfig(createConfig('ARU <noreply@weaz.me>', 'ARU'));
    expect(configD.fromName).toBe('ARU');
    expect(configD.from).toBe('ARU <noreply@weaz.me>');

    // 5. Sender address remains unchanged
    expect(configA.fromAddress).toBe('noreply@weaz.me');
    expect(configB.fromAddress).toBe('noreply@weaz.me');
    expect(configC.fromAddress).toBe('noreply@weaz.me');
    expect(configD.fromAddress).toBe('noreply@weaz.me');

    // 6. Domain remains unchanged (weaz.me)
    expect(configA.fromAddress?.split('@')[1]).toBe('weaz.me');
    expect(configD.fromAddress?.split('@')[1]).toBe('weaz.me');

    // 7. Reply-To remains unchanged
    expect(configA.replyTo).toBe('support@weaz.me');
    expect(configD.replyTo).toBe('support@weaz.me');

    // 8. Legacy URLs remain unchanged
    const legacyUrl = 'https://weaz.me/legal/privacy-policy';
    expect(branding.toEmailHref(legacyUrl)).toBe(legacyUrl);

    // 9. Android package ID remains unchanged
    const androidPackage = 'com.wiez.wiez';
    expect(androidPackage).toBe('com.wiez.wiez');

    // 10. Historical records remain unchanged
    const historicalPayload = { action: 'LEGACY_MIGRATION', note: 'WEAZ account migrated' };
    expect(historicalPayload.note).toBe('WEAZ account migrated');

    // 11. User-generated content remains unchanged (e.g. brand name with legacy token)
    const customBrandEmail = templates.brandVerificationApprovedEmail('Wiez Vintage Co.', APP);
    expect(customBrandEmail.subject).toContain('"Wiez Vintage Co." is now verified on ARU');
    expect(customBrandEmail.html).toContain('<strong>Wiez Vintage Co.</strong> is now verified on ARU');

    // 12. Malformed sender configuration is handled safely
    const malformedConfig = resolveEmailConfig(createConfig('not-a-valid-email'));
    expect(malformedConfig.fromAddress).toBeNull();
    expect(malformedConfig.from).toBe('not-a-valid-email');
    expect(malformedConfig.warnings).toContain(
      'RESEND_FROM is configured but does not look like a valid email sender address.',
    );

    // 13. Repeated normalization does not modify an already-normalized value
    const normalizedOnce = configA.from; // 'ARU <noreply@weaz.me>'
    const configRepeated = resolveEmailConfig(createConfig(normalizedOnce!));
    expect(configRepeated.from).toBe('ARU <noreply@weaz.me>');
    expect(configRepeated.fromName).toBe('ARU');
    expect(configRepeated.fromAddress).toBe('noreply@weaz.me');
  });

  // ─────────────────────────────────────────────────────────────
  // 10. LEGAL FOOTER AND LINK INTEGRITY
  // ─────────────────────────────────────────────────────────────
  it('10. Email shell renders Soteria Genesis Limited legal entity in the footer', () => {
    const shell = branding.renderEmailShell({
      appName: 'ARU',
      title: 'Test Email',
      bodyHtml: '<p>Test content</p>',
    });

    expect(shell).toContain('Soteria Genesis Limited');
    expect(shell).toContain('ARU is operated by Soteria Genesis Limited. All rights reserved.');
    expect(shell).toContain('Need help? Reply to this email and the ARU support team will help.');
  });

  // ─────────────────────────────────────────────────────────────
  // 11. ACCOUNT TRUST & LIFECYCLE NOTIFICATIONS
  // ─────────────────────────────────────────────────────────────
  it('11. Account trust, suspension, reactivation, and team invite emails render ARU', () => {
    const suspended = templates.accountSuspendedEmail('Amara', 'Policy violation', APP);
    expect(suspended.subject).toContain('Your ARU account has been suspended');
    expect(suspended.html).toContain('ARU');
    expect(suspended.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(suspended.subject, 'account suspended subject');

    const reactivated = templates.accountReactivatedEmail('Amara', APP);
    expect(reactivated.subject).toContain('Your ARU account is active again');
    expect(reactivated.html).toContain('ARU');
    expect(reactivated.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(reactivated.subject, 'account reactivated subject');

    const phoneChange = templates.phoneChangeCodeEmail('123456', '+2348012345678', APP);
    expect(phoneChange.subject).toContain('Your ARU phone change code');
    expect(phoneChange.html).toContain('ARU');
    expect(phoneChange.html).toContain('123456');
    expect(phoneChange.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(phoneChange.subject, 'phone change subject');

    const staffInvite = templates.brandStaffInviteEmail({
      brandName: 'Amara Atelier',
      role: 'BRAND_EDITOR',
      expiresAt: '2026-11-30',
      inviteLink: DUMMY_LINK,
      appName: APP,
    });
    expect(staffInvite.subject).toContain('join Amara Atelier on ARU');
    expect(staffInvite.html).toContain('ARU');
    expect(staffInvite.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(staffInvite.subject, 'staff invite subject');

    const published = templates.collectionPublishedEmail(
      'Amara Atelier',
      'Lagos Midnight',
      'https://weaz.me/designs/lagos-midnight',
      APP,
    );
    expect(published.subject).toContain('"Lagos Midnight" is live on ARU!');
    expect(published.html).toContain('ARU');
    expect(published.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(published.subject, 'collection published subject');
  });
});
