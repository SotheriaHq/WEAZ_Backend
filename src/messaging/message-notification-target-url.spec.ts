import { MessageContextType, MessageParticipantRole } from '@prisma/client';
import { MessagingService } from './messaging.service';

/**
 * A notification about a message must point INTO messaging.
 *
 * The deep link this builds is stored on the notification and is the first
 * thing the web client obeys when the reader taps it, ahead of all of its
 * type-based routing. So a wrong answer here is not a cosmetic one: it decides
 * where the reader lands.
 *
 * The regression this exists for: the no-context branch returned the literal
 * '/settings?tab=notifications'. Tapping "You have unread order messages
 * waiting" opened the notifications settings screen — the screen the reader had
 * just tapped from — with no route to the message it was announcing.
 *
 * `resolveThreadTargetUrl` is pure, so the prototype is enough; constructing the
 * real service would drag in the whole module graph to test a string builder.
 */
const resolve = (
  contextType: MessageContextType,
  orderId: string | null,
  customOrderId: string | null,
  brandId: string | null,
  recipientRole: MessageParticipantRole,
  threadId?: string,
  messageId?: string,
): string =>
  (Object.create(MessagingService.prototype) as any).resolveThreadTargetUrl(
    contextType,
    orderId,
    customOrderId,
    brandId,
    recipientRole,
    threadId,
    messageId,
  );

const MESSAGING_PREFIXES = [
  '/messages',
  '/studio/messages',
  '/admin/messaging',
  '/admin/custom-orders',
];

/**
 * Mirrors `isMessagingRoute` in `fthreadly/src/utils/notificationRouting.ts`.
 * The two must agree: this decides what the server is allowed to write, that
 * decides what the client is willing to obey, and a route only one of them
 * recognises is a message notification that goes nowhere.
 */
const isMessagingRoute = (route: string) =>
  // The brand order chat: the orders tab with the chat panel already open.
  (route.startsWith('/studio?tab=orders') && route.includes('openChat=1')) ||
  MESSAGING_PREFIXES.some(
    (prefix) =>
      route === prefix ||
      route.startsWith(`${prefix}?`) ||
      route.startsWith(`${prefix}/`) ||
      route.startsWith(`${prefix}#`),
  );

describe('message notification target url', () => {
  it('never leaves messaging, for any combination of missing context', () => {
    const contexts = [
      MessageContextType.CUSTOM_ORDER,
      MessageContextType.STANDARD_ORDER,
      ...Object.values(MessageContextType),
    ];
    const roles = Object.values(MessageParticipantRole);

    for (const contextType of contexts) {
      for (const role of roles) {
        for (const orderId of [null, 'order-1']) {
          for (const customOrderId of [null, 'custom-order-1']) {
            for (const threadId of [undefined, 'thread-1']) {
              const route = resolve(
                contextType,
                orderId,
                customOrderId,
                'brand-1',
                role,
                threadId,
              );
              expect(
                isMessagingRoute(route)
                  ? true
                  : `${contextType}/${role} order=${orderId} custom=${customOrderId} thread=${threadId} -> ${route}`,
              ).toBe(true);
            }
          }
        }
      }
    }
  });

  it('sends a brand owner to studio messaging and everyone else to the inbox', () => {
    const brandRoute = resolve(
      MessageContextType.INQUIRY,
      null,
      null,
      null,
      MessageParticipantRole.BRAND_OWNER,
    );
    const buyerRoute = resolve(
      MessageContextType.INQUIRY,
      null,
      null,
      null,
      MessageParticipantRole.BUYER,
    );

    expect(brandRoute).toBe('/studio/messages');
    expect(buyerRoute).toBe('/messages');
  });

  it('carries the thread id when there is one', () => {
    const route = resolve(
      MessageContextType.CUSTOM_ORDER,
      null,
      'custom-order-9',
      'brand-1',
      MessageParticipantRole.BUYER,
      'thread-9',
    );
    expect(route).toContain('thread=thread-9');
    expect(route).toContain('customOrderId=custom-order-9');
  });
});
