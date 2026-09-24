import { NotificationType } from '@prisma/client';
import { renderNotificationEmail } from './email.policy';

/**
 * Every actionable email must give the reader somewhere to go.
 *
 * The motivating failure: "#CO-F9967352 needs a quick review. Tap to open it
 * and take action." arrived with no button and no link — the code was plain
 * text and the sender had not set `payload.targetUrl`. The copy said "tap" and
 * there was nothing to tap.
 */
describe('notification email actions', () => {
  const baseArgs = {
    appName: 'WIEZ',
    heading: 'Custom order admin review triggered',
    message: '#CO-F9967352 needs a quick review. Tap to open it and take action.',
    notificationType: NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
    payload: { customOrderId: 'f9967352-1111-2222-3333-444455556666' },
  };

  it('turns the order code in the copy into a link to the order', () => {
    const rendered = renderNotificationEmail({
      ...baseArgs,
      targetUrl: 'https://weaz.me/admin/custom-orders/f9967352',
    });

    expect(rendered.html).toContain(
      '<a href="https://weaz.me/admin/custom-orders/f9967352"',
    );
    // The code itself is the link text, not a bare string next to one.
    expect(rendered.html).toMatch(/>#CO-F9967352<\/a>/);
  });

  it('names the destination on the button instead of "Open in WIEZ"', () => {
    const admin = renderNotificationEmail({
      ...baseArgs,
      targetUrl: 'https://weaz.me/admin/custom-orders/f9967352',
    });
    expect(admin.html).toContain('Review order #CO-F9967352');

    const buyer = renderNotificationEmail({
      ...baseArgs,
      targetUrl: 'https://weaz.me/custom-orders/f9967352',
    });
    expect(buyer.html).toContain('View order #CO-F9967352');
    expect(buyer.html).not.toContain('Open in WIEZ');
  });

  it('offers the raw link too, for clients that mangle the button', () => {
    const rendered = renderNotificationEmail({
      ...baseArgs,
      targetUrl: 'https://weaz.me/custom-orders/f9967352',
    });
    expect(rendered.html).toContain('Button not working?');
  });

  it('says the same thing in the plain-text part', () => {
    const rendered = renderNotificationEmail({
      ...baseArgs,
      targetUrl: 'https://weaz.me/custom-orders/f9967352',
    });
    expect(rendered.text).toContain(
      'View order #CO-F9967352: https://weaz.me/custom-orders/f9967352',
    );
  });

  it('renders cleanly with no destination rather than a dead button', () => {
    const rendered = renderNotificationEmail(baseArgs);
    expect(rendered.html).not.toContain('Button not working?');
    expect(rendered.html).toContain('#CO-F9967352');
    // No anchor was invented for a link we do not have.
    expect(rendered.html).not.toMatch(/>#CO-F9967352<\/a>/);
  });

  it('links the customer to their profile and shows the order as its code', () => {
    const rendered = renderNotificationEmail({
      appName: 'WIEZ',
      heading: 'Custom order review required',
      message: 'Payment confirmed. The order is ready for production updates.',
      notificationType: NotificationType.CUSTOM_ORDER_REVIEW_REQUIRED,
      targetUrl: 'https://weaz.me/studio/custom-orders/f9967352',
      payload: {
        customOrderId: 'f9967352-1111-2222-3333-444455556666',
        buyerDisplayName: 'Jayde Druid',
        buyerUsername: 'jayde',
        sourceBrandName: 'Danny’s Anime Stuff',
      },
    });

    expect(rendered.html).toContain('/u/jayde');
    expect(rendered.html).toMatch(/>Jayde Druid<\/a>/);
    // The order row reads as the code, not a 36-character UUID.
    expect(rendered.html).toContain('#CO-F9967352');
    expect(rendered.html).not.toContain('f9967352-1111-2222-3333-444455556666');
  });

  /*
    Escaping still has to hold. The linkifier runs over already-escaped text,
    so a payload cannot smuggle markup through a display name.
  */
  it('escapes names and never emits raw markup from a payload', () => {
    const rendered = renderNotificationEmail({
      appName: 'WIEZ',
      heading: 'Custom order review required',
      message: 'Payment confirmed.',
      notificationType: NotificationType.CUSTOM_ORDER_REVIEW_REQUIRED,
      targetUrl: 'https://weaz.me/studio/custom-orders/f9967352',
      payload: {
        customOrderId: 'f9967352-1111-2222-3333-444455556666',
        buyerDisplayName: '<img src=x onerror=alert(1)>',
        buyerUsername: 'not a valid handle!',
      },
    });

    expect(rendered.html).not.toContain('<img src=x');
    expect(rendered.html).toContain('&lt;img src=x');
    // An unusable handle produces no link at all, rather than a broken one.
    expect(rendered.html).not.toContain('/u/not a valid handle!');
  });
});
