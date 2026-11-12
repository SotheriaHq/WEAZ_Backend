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
    // Good news opens with 🎉 (documents approved, verified); the rest wave.
    expect(presentation.hiddenBody).toMatch(/^Wiez (👋|🎉) /);
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

describe('signup pushes: welcome, verify your email, verified', () => {
  const signup = NotificationRegistry.createDefault().getConfig(NotificationType.SIGNUP)!;
  const actions = ['SIGNUP', 'VERIFY_EMAIL', 'EMAIL_VERIFIED'] as const;

  it('each signup moment has its own title and preview-off line, none a security alert', () => {
    const shown = actions.map((action) => getPushPresentation(NotificationType.SIGNUP, { action }));
    expect(new Set(shown.map((p) => p.title)).size).toBe(actions.length);
    expect(new Set(shown.map((p) => p.hiddenBody)).size).toBe(actions.length);
    for (const p of shown) expect(p.title).not.toMatch(/security/i);
    expect(shown[1].title).toBe('Verify your email ✉️');
  });

  it('accepts the verify-email payload and never puts a code in the text', () => {
    const payload = { action: 'VERIFY_EMAIL', email: 'ada@example.com', displayName: 'Ada', targetUrl: '/verify-email' };
    expect(signup.schema.validate(payload).error).toBeUndefined();
    const text = signup.formatter({ payload });
    expect(text).toBe('Verify your email to enjoy WIEZ. Your code is in your inbox.');
    expect(text).not.toMatch(/\d/);
  });
});

describe('Wiez is how WIEZ says hello', () => {
  it('greets by name, or on its own', () => {
    expect(wiezGreeting('Ebi')).toBe('Wiez Ebi 👋');
    expect(wiezGreeting('  ')).toBe('Wiez 👋');
    expect(wiezGreeting(null)).toBe('Wiez 👋');
  });

  it('celebrates good news with 🎉', () => {
    expect(wiezGreeting('Ebi', '🎉')).toBe('Wiez Ebi 🎉');
    expect(wiezGreeting(undefined, '🎉')).toBe('Wiez 🎉');
  });
});

/*
 * Brand verification says which step happened and what comes next (owner,
 * Nov 2026: the brand whose documents were approved got "There's news on
 * your brand verification", with no word that a physical visit is next).
 */
describe('brand verification pushes say what happened and what is next', () => {
  const verificationTypes = Object.values(NotificationType).filter((type) =>
    String(type).startsWith('VERIFICATION_'),
  );

  const physicalRequired = NotificationType.VERIFICATION_PHYSICAL_REQUIRED;

  it('every verification step has its own preview-off line', () => {
    const lines = verificationTypes.map(
      (type) => getPushPresentation(type).hiddenBody,
    );
    expect(new Set(lines).size).toBe(lines.length);
    for (const line of lines) {
      expect(line).not.toBe('Wiez 👋 There’s news on your brand verification.');
    }
  });

  it('documents approved: celebrates and names the visit as the last step', () => {
    const presentation = getPushPresentation(physicalRequired);
    expect(presentation.title).toBe('Documents approved 🎉');
    expect(presentation.hiddenBody).toMatch(
      /^Wiez 🎉 Your brand documents are approved\. Last step: a short verification visit/,
    );

    const config =
      NotificationRegistry.createDefault().getConfig(physicalRequired)!;
    const notification = {
      payload: { brandId: 'b1', brandName: "Ebi's Lines" },
    };
    expect(config.pushFormatter!(notification)).toBe(
      "Wiez Ebi's Lines 🎉 Your brand documents are approved. Last step: a short verification visit — we’ll send you times to choose from.",
    );
    expect(config.formatter(notification)).toMatch(
      /approved\. Last step: a short physical verification visit\. We’ll send you times/,
    );
  });

  it('accepts the brand name in the payload', () => {
    const config =
      NotificationRegistry.createDefault().getConfig(physicalRequired)!;
    const { error } = config.schema.validate({
      brandId: 'b1',
      brandName: "Ebi's Lines",
      documentsApprovedAt: 'x',
      targetUrl: '/studio/verification',
    });
    expect(error).toBeUndefined();
  });

  it('the video-call request reaches the agent with its own title and line', () => {
    const type = 'VERIFICATION_VIDEO_CALL_REQUESTED' as NotificationType;
    const presentation = getPushPresentation(type);
    expect(presentation.title).toBe('Video call requested 🎥');
    expect(presentation.hiddenBody).toMatch(
      /^Wiez 👋 A brand asked for a video call instead of a visit/,
    );
    const config = NotificationRegistry.createDefault().getConfig(type)!;
    expect(config.formatter({ payload: { brandName: 'Nuel' } })).toBe(
      'Nuel asked for a video call instead of a visit. Send call times with a link.',
    );
  });

  it('documents approved tells a free brand about the video call', () => {
    const config =
      NotificationRegistry.createDefault().getConfig(physicalRequired)!;
    const notification = {
      payload: { brandId: 'b1', brandName: "Ebi's Lines", videoCallAllowed: true },
    };
    expect(config.pushFormatter!(notification)).toContain(
      'a short verification visit or a live video call',
    );
    expect(config.formatter(notification)).toContain(
      'or a live video call if you prefer',
    );
  });

  it('visit-time and reminder notices say "video call" for a call', () => {
    const registry = NotificationRegistry.createDefault();
    const proposed = registry.getConfig(
      NotificationType.VERIFICATION_VISIT_PROPOSED,
    )!;
    expect(
      proposed.formatter({ payload: { slots: ['a', 'b'], mode: 'VIDEO_CALL' } }),
    ).toBe('Choose a time for your verification video call (2 options)');
    const reminder = registry.getConfig(
      NotificationType.VERIFICATION_VISIT_REMINDER,
    )!;
    expect(
      reminder.formatter({ payload: { when: 'tomorrow', mode: 'VIDEO_CALL' } }),
    ).toBe('Verification video call tomorrow');
  });
});
