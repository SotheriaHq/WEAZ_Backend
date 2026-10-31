import { NotificationType } from '@prisma/client';

/**
 * Every link in every email is an absolute https link on the web app's host.
 *
 * A mail client cannot follow a relative href, and an absolute link on the web
 * host is what lets the Android app claim it (App Links): the same button opens
 * the installed app on a phone and the website everywhere else.
 */
const WEB = 'https://app.wiez.test';
const ORIGINAL_ENV = process.env;

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) =>
    match[1].replace(/&amp;/g, '&'),
  );
}

function textUrls(text: string): string[] {
  return [...String(text ?? '').matchAll(/https?:\/\/[^\s)"]+/g)].map(
    (match) => match[0],
  );
}

function expectWebLinks(label: string, html: string, text: string) {
  for (const href of hrefs(html)) {
    if (href.startsWith('mailto:')) continue;
    expect({ label, href, onWebHost: href.startsWith(`${WEB}/`) }).toEqual({
      label,
      href,
      onWebHost: true,
    });
  }
  for (const url of textUrls(text)) {
    expect({ label, url, onWebHost: url.startsWith(`${WEB}/`) }).toEqual({
      label,
      url,
      onWebHost: true,
    });
  }
}

describe('email links', () => {
  let templates: typeof import('./email.templates');
  let policy: typeof import('../notifications/email.policy');
  let links: typeof import('../common/utils/auth-links');
  let branding: typeof import('./email.branding');

  beforeAll(() => {
    process.env = {
      ...ORIGINAL_ENV,
      APP_ENV: undefined,
      DEPLOY_ENV: undefined,
      NODE_ENV: 'test',
      WEB_APP_URL: `${WEB}/`,
      FRONTEND_URL: undefined,
      EMAIL_BRAND_LOGO_URL: undefined,
      MOBILE_APP_URL: undefined,
    };
    // The templates resolve some URLs at import time, so import after the env.
    jest.isolateModules(() => {
      templates = jest.requireActual('./email.templates');
      policy = jest.requireActual('../notifications/email.policy');
      links = jest.requireActual('../common/utils/auth-links');
      branding = jest.requireActual('./email.branding');
    });
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('every template links only to the web app', () => {
    const app = 'WIEZ';
    const rendered: Record<string, { html: string; text?: string }> = {
      passwordResetEmail: templates.passwordResetEmail(
        links.buildPasswordResetLink('tok'),
        app,
      ),
      emailVerificationEmail: templates.emailVerificationEmail(
        links.buildEmailVerificationLink('tok', '/profile'),
        app,
      ),
      phoneChangeCodeEmail: templates.phoneChangeCodeEmail(
        '123456',
        '+2348030000000',
        app,
      ),
      payoutRequestCodeEmail: templates.payoutRequestCodeEmail(
        '123456',
        'NGN 10,000',
        'Ada Studio',
        app,
      ),
      emailLoginCodeEmail: templates.emailLoginCodeEmail('123456', app),
      breakGlassCodeEmail: templates.breakGlassCodeEmail('123456', app),
      breakGlassSuperAdminRecoveryEmail:
        templates.breakGlassSuperAdminRecoveryEmail({
          email: 'root@wiez.test',
          temporaryPassword: 'Temp-pass-1',
          appName: app,
        }),
      adminAccountCreatedEmail: templates.adminAccountCreatedEmail(
        'admin@wiez.test',
        'Temp-pass-1',
        `${WEB}/admin/login`,
        app,
      ),
      brandStaffInviteEmail: templates.brandStaffInviteEmail({
        brandName: 'Ada Studio',
        role: 'EDITOR',
        expiresAt: new Date('2026-11-05T00:00:00Z'),
        inviteLink: branding.resolveAppUrl('/brand/staff/invite?token=tok'),
        appName: app,
      }),
      brandVerificationApprovedEmail: templates.brandVerificationApprovedEmail(
        'Ada Studio',
        app,
      ),
      verificationSubmittedEmail: templates.verificationSubmittedEmail(
        'Ada Studio',
        app,
      ),
      verificationInReviewEmail: templates.verificationInReviewEmail(
        'Ada Studio',
        app,
      ),
      verificationInfoRequestedEmail: templates.verificationInfoRequestedEmail(
        'Ada Studio',
        ['Business registration'],
        app,
      ),
      brandVerificationRejectedEmail: templates.brandVerificationRejectedEmail(
        'Ada Studio',
        'Documents unreadable',
        app,
      ),
      verificationCooldownExpiredEmail:
        templates.verificationCooldownExpiredEmail('Ada Studio', app),
      verificationNudgeEmail: templates.verificationNudgeEmail(
        'Ada Studio',
        app,
      ),
      accountSuspendedEmail: templates.accountSuspendedEmail(
        'Ada',
        'Policy review',
        app,
      ),
      accountReactivatedEmail: templates.accountReactivatedEmail('Ada', app),
      confirmEmailChangeEmail: templates.confirmEmailChangeEmail(
        links.buildEmailChangeConfirmationLink('tok'),
        'new@wiez.test',
        app,
      ),
      passwordChangedSecurityAlertEmail:
        templates.passwordChangedSecurityAlertEmail(app),
      emailChangedSecurityAlertEmail: templates.emailChangedSecurityAlertEmail(
        'old@wiez.test',
        'new@wiez.test',
        app,
      ),
      // Notification payloads usually carry a path, not a URL.
      collectionPublishedEmail: templates.collectionPublishedEmail(
        'Ada Studio',
        'Indigo Agbada',
        '/designs/design-1',
        app,
      ),
      disputeResolvedEmail: templates.disputeResolvedEmail(
        'dispute-1',
        'Refunded',
        app,
      ),
      payoutProcessedEmail: templates.payoutProcessedEmail(
        '10,000',
        'NGN',
        'PAID',
        app,
      ),
      adminEmailChangeOtpEmail: templates.adminEmailChangeOtpEmail(
        '123456',
        'new@wiez.test',
        app,
      ),
      adminEmailChangeApprovedEmail: templates.adminEmailChangeApprovedEmail(
        'new@wiez.test',
        'old@wiez.test',
        app,
      ),
      adminEmailChangeRejectedEmail: templates.adminEmailChangeRejectedEmail(
        'new@wiez.test',
        'Not verified',
        app,
      ),
    };

    // A new template must be added here too.
    const exported = Object.keys(templates).filter((name) =>
      name.endsWith('Email'),
    );
    expect(Object.keys(rendered).sort()).toEqual(exported.sort());

    for (const [name, email] of Object.entries(rendered)) {
      expectWebLinks(name, email.html, email.text ?? '');
    }
    expect(hrefs(rendered.collectionPublishedEmail.html)).toContain(
      `${WEB}/designs/design-1`,
    );
    expect(rendered.collectionPublishedEmail.text).toContain(
      `${WEB}/designs/design-1`,
    );
  });

  it('turns a notification path into one absolute link everywhere', () => {
    const email = policy.renderNotificationEmail({
      appName: 'WIEZ',
      heading: 'Order shipped',
      message: 'Your order is on its way.',
      notificationType: NotificationType.ORDER_STATUS_UPDATED,
      targetUrl: '/profile?tab=orders&orderId=order-1',
      payload: { orderId: 'order-1' },
    });
    const absolute = `${WEB}/profile?tab=orders&orderId=order-1`;
    expect(hrefs(email.html)).toContain(absolute);
    expect(email.html).not.toContain('href="/profile');
    expectWebLinks('ORDER_STATUS_UPDATED', email.html, email.text);
  });

  it('keeps absolute and mailto links as they are', () => {
    expect(branding.toEmailHref(`${WEB}/admin/finance`)).toBe(
      `${WEB}/admin/finance`,
    );
    expect(branding.toEmailHref('mailto:support@wiez.test')).toBe(
      'mailto:support@wiez.test',
    );
    expect(branding.toEmailHref('//evil.example/x')).toBe('//evil.example/x');
    expect(branding.toEmailHref('/orders/1')).toBe(`${WEB}/orders/1`);
  });
});
