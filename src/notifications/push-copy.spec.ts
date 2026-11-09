import { NotificationType } from '@prisma/client';
import {
  contentReviewInboxMessage,
  contentReviewPushBody,
} from 'src/content-integrity/content-review-copy';
import { NotificationRegistry } from './notifications.registry';
import { getPushPresentation } from './push-presentation';
import { wiezGreeting } from './wiez-voice';

/*
 * No push reads generically (owner, Nov 2026: "I don't want users getting
 * those"). SIT showed every content-review push as "WIEZ / Something new for
 * you on WIEZ 👀" because the recipient had previews off. Now every type has
 * its own title and its own preview-off line, and these checks keep it so.
 */

const GENERIC = /something new|status updated|you have a notification/i;

describe('push copy: every notification type speaks for itself', () => {
  const registry = NotificationRegistry.createDefault();

  it.each(Object.values(NotificationType))('%s has its own title and preview-off line', (type) => {
    const presentation = getPushPresentation(type);
    expect(presentation.isFallback).not.toBe(true);
    expect(presentation.title).not.toBe('WIEZ');
    expect(presentation.hiddenBody).toMatch(/^Wiez 👋 /);
    expect(presentation.hiddenBody).not.toMatch(GENERIC);
  });

  it.each(Object.values(NotificationType))('%s formats a non-generic line even from an empty payload', (type) => {
    const config = registry.getConfig(type);
    expect(config).toBeDefined();
    const notification = { id: 'n1', type, payload: {}, actor: null };
    const inbox = config!.formatter(notification);
    const push = (config!.pushFormatter ?? config!.formatter)(notification);
    expect(String(inbox).trim()).not.toBe('');
    expect(String(push).trim()).not.toBe('');
    expect(inbox).not.toMatch(GENERIC);
    expect(push).not.toMatch(GENERIC);
  });
});

describe('content review copy', () => {
  const design = { title: 'Ankara Wrap Dress', entityType: 'DESIGN' };
  const product = { title: 'Adire Shirt', entityType: 'PRODUCT' };

  it('submitted: "<title> sent for review", and never names the admins', () => {
    const push = contentReviewPushBody('CONTENT_SUBMITTED_FOR_REVIEW', design);
    const inbox = contentReviewInboxMessage('CONTENT_SUBMITTED_FOR_REVIEW', { ...design, when: '9 Nov, 14:05' });
    expect(push).toBe('“Ankara Wrap Dress” sent for review. We’ll let you know the moment it’s live.');
    expect(inbox).toContain('“Ankara Wrap Dress” sent for review (9 Nov, 14:05).');
    expect(`${push} ${inbox}`).not.toMatch(/admin/i);
  });

  it('changes requested: greets with "Wiez <brand> 👋" and points at the fix', () => {
    const input = {
      ...design,
      recipientName: "Ebi's Lines",
      reasonLabel: 'Poor image quality',
      reasonNote: 'The front view is blurry.',
    };
    const push = contentReviewPushBody('CONTENT_CHANGES_REQUESTED', input);
    const inbox = contentReviewInboxMessage('CONTENT_CHANGES_REQUESTED', input);
    expect(push).toBe("Wiez Ebi's Lines 👋 A few changes were requested on “Ankara Wrap Dress”. Tap to see what to update.");
    expect(inbox).toContain('What to update: Poor image quality — The front view is blurry.');
    expect(inbox).toContain('resubmit for review');
    expect(`${push} ${inbox}`).not.toMatch(/admin/i);
  });

  it('approved: published on the Runway for designs, the Market for products', () => {
    expect(contentReviewPushBody('CONTENT_REVIEW_APPROVED', design)).toBe(
      '“Ankara Wrap Dress” has been approved and published on the Runway 🎉',
    );
    expect(contentReviewPushBody('CONTENT_REVIEW_APPROVED', product)).toBe(
      '“Adire Shirt” has been approved and published on the Market 🎉',
    );
    expect(contentReviewPushBody('CONTENT_REVIEW_APPROVED', { ...design, isPrivate: true })).toContain('set to Private');
  });

  it('a missing title still reads naturally', () => {
    expect(contentReviewPushBody('CONTENT_SUBMITTED_FOR_REVIEW', { entityType: 'PRODUCT' })).toBe(
      'Your product sent for review. We’ll let you know the moment it’s live.',
    );
  });

  it('the registry uses the short push copy and keeps the stored inbox message', () => {
    const config = NotificationRegistry.createDefault().getConfig(NotificationType.CONTENT_CHANGES_REQUESTED)!;
    const notification = {
      payload: { title: 'Ankara Wrap Dress', entityType: 'DESIGN', recipientName: "Ebi's Lines", message: 'Stored inbox text.' },
    };
    expect(config.formatter(notification)).toBe('Stored inbox text.');
    expect(config.pushFormatter!(notification)).toBe(
      "Wiez Ebi's Lines 👋 A few changes were requested on “Ankara Wrap Dress”. Tap to see what to update.",
    );
  });
});

describe('Wiez is how WIEZ says hello', () => {
  it('greets by name, or on its own', () => {
    expect(wiezGreeting('Ebi')).toBe('Wiez Ebi 👋');
    expect(wiezGreeting('  ')).toBe('Wiez 👋');
    expect(wiezGreeting(null)).toBe('Wiez 👋');
  });
});
