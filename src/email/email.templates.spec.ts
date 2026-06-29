import { NotificationType } from '@prisma/client';
import {
  accountReactivatedEmail,
  adminEmailChangeOtpEmail,
  brandStaffInviteEmail,
  brandVerificationApprovedEmail,
  breakGlassCodeEmail,
  emailLoginCodeEmail,
  emailVerificationEmail,
  passwordResetEmail,
} from './email.templates';
import { renderNotificationEmail } from 'src/notifications/email.policy';

const joinedOutput = (value: {
  subject: string;
  html: string;
  text?: string;
}) => [value.subject, value.html, value.text ?? ''].join('\n');

const legacyBrandInput = ['Th', 'readly'].join('');
const legacyBrandPattern = new RegExp(
  `${legacyBrandInput}|${legacyBrandInput.toLowerCase()}|${legacyBrandInput.toUpperCase()}`,
);

describe('email template branding polish', () => {
  it('uses polished WEAZ subjects for representative active email flows', () => {
    expect(
      passwordResetEmail('https://weaz.test/reset', legacyBrandInput).subject,
    ).toBe('🔐 Reset your WEAZ password');
    expect(
      emailVerificationEmail('https://weaz.test/verify', legacyBrandInput)
        .subject,
    ).toBe("✨ You're almost in — confirm your WEAZ email");
    expect(emailLoginCodeEmail('123456', legacyBrandInput).subject).toBe(
      '🔐 Your WEAZ password setup code',
    );
    expect(
      emailLoginCodeEmail('123456', legacyBrandInput, 'DIRECT_LOGIN').subject,
    ).toBe('🔐 Your WEAZ sign-in code');
    expect(breakGlassCodeEmail('CODE-123', legacyBrandInput).subject).toBe(
      'URGENT: WEAZ break-glass recovery code',
    );
    expect(
      brandStaffInviteEmail({
        brandName: 'Aso Studio',
        role: 'CATALOG_MANAGER',
        expiresAt: new Date('2026-06-10T12:00:00.000Z'),
        inviteLink: 'https://weaz.test/brand/staff/invite?token=token',
        appName: legacyBrandInput,
      }).subject,
    ).toBe("🏷️ You've been invited to join Aso Studio on WEAZ");
    expect(
      brandVerificationApprovedEmail('Aso Studio', legacyBrandInput).subject,
    ).toBe('✅ "Aso Studio" is now verified on WEAZ');
    expect(accountReactivatedEmail('Ada', legacyBrandInput).subject).toBe(
      '✅ Your WEAZ account is active again',
    );
    expect(
      adminEmailChangeOtpEmail('123456', 'admin@weaz.test', legacyBrandInput)
        .subject,
    ).toBe('WEAZ admin email verification code');
  });

  it('keeps old brand names and redirect metadata out of active email output', () => {
    const outputs = [
      passwordResetEmail('https://weaz.test/reset', legacyBrandInput),
      emailVerificationEmail('https://weaz.test/verify', legacyBrandInput),
      brandVerificationApprovedEmail('Aso Studio', legacyBrandInput),
      renderNotificationEmail({
        appName: legacyBrandInput,
        heading: 'Order placed',
        message: 'Your order was placed successfully.',
        targetUrl: 'https://weaz.test/orders/order-1',
        notificationType: NotificationType.ORDER_PLACED,
      }),
    ].map(joinedOutput);

    for (const output of outputs) {
      expect(output).toContain('WEAZ');
      expect(output).not.toMatch(legacyBrandPattern);
      expect(output).not.toContain('[SIT');
      expect(output).not.toContain('REDIRECT');
      expect(output).not.toContain('email_fingerprint');
    }
  });
});
