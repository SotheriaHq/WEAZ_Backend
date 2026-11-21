import { NotificationType } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

import { PRODUCT_NAME } from '../common/branding/product-identity.constants';
import * as templates from './email.templates';
import * as branding from './email.branding';
import * as policy from '../notifications/email.policy';
import { resolveEmailConfig } from './email.config';

describe('Rendered Customer-Facing Email Branding & Legal Entity Suite', () => {
  const APP = PRODUCT_NAME; // 'ARU'
  const DUMMY_LINK = 'https://app.aru.fashion/auth/verify?token=test-token-xyz';
  const LEGAL_ENTITY = 'Soteria Genesis Limited';

  const inspectNoLegacyBranding = (text: string, context: string) => {
    // Prohibit WIEZ, WEAZ, Wiezing, and Threadly in rendered customer-facing strings
    // Note: Temporary asset filename stems (e.g. wiez-email-logo.png) are excluded from copy checks
    const copyOnly = text.replace(/wiez-email-logo\.png/g, '');
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
  it('4. Security notification emails render ARU branding', () => {
    const pwdAlert = templates.passwordChangedSecurityAlertEmail(APP);
    expect(pwdAlert.subject).toContain('security alert');
    expect(pwdAlert.subject).toContain('ARU');
    expect(pwdAlert.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(pwdAlert.subject, 'password alert subject');
    inspectNoLegacyBranding(pwdAlert.html, 'password alert html');

    const emailAlert = templates.emailChangedSecurityAlertEmail('old@aru.fashion', 'new@aru.fashion', APP);
    expect(emailAlert.subject).toContain('security alert');
    expect(emailAlert.subject).toContain('ARU');
    expect(emailAlert.html).toContain(LEGAL_ENTITY);
    inspectNoLegacyBranding(emailAlert.subject, 'email alert subject');
    inspectNoLegacyBranding(emailAlert.html, 'email alert html');
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
  });

  // ─────────────────────────────────────────────────────────────
  // 9. SENDER DISPLAY NAME CANONICALIZATION (DEFENSIVE RESOLUTION)
  // ─────────────────────────────────────────────────────────────
  it('9. Sender display names automatically upgrade legacy strings (WIEZ/WEAZ/Threadly) to ARU', () => {
    const createConfig = (fromValue: string, appNameValue?: string): ConfigService => {
      const values: Record<string, string | undefined> = {
        EMAIL_PROVIDER: 'resend',
        EMAIL_MODE: 'log_only',
        RESEND_FROM: fromValue,
        APP_NAME: appNameValue,
      };
      return {
        get: jest.fn((key: string) => values[key]),
      } as unknown as ConfigService;
    };

    // Case A: RESEND_FROM is legacy WIEZ
    const configA = resolveEmailConfig(createConfig('WIEZ <noreply@weaz.me>'));
    expect(configA.fromName).toBe('ARU');
    expect(configA.appName).toBe('ARU');

    // Case B: RESEND_FROM is legacy WEAZ with custom app name
    const configB = resolveEmailConfig(createConfig('WEAZ <noreply@weaz.me>', 'WIEZ'));
    expect(configB.fromName).toBe('ARU');
    expect(configB.appName).toBe('ARU');

    // Case C: RESEND_FROM is already ARU
    const configC = resolveEmailConfig(createConfig('ARU <noreply@weaz.me>', 'ARU'));
    expect(configC.fromName).toBe('ARU');
    expect(configC.appName).toBe('ARU');
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
});
