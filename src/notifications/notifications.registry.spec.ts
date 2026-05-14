import { NotificationType } from '@prisma/client';
import { NotificationRegistry } from './notifications.registry';

describe('NotificationRegistry', () => {
  let registry: NotificationRegistry;

  beforeEach(() => {
    registry = NotificationRegistry.createDefault();
  });

  it('registers every NotificationType enum value', () => {
    const registered = new Set(registry.getAllTypes());

    for (const type of Object.values(NotificationType)) {
      expect(registered.has(type)).toBe(true);
    }
  });

  it('registers wishlist availability notification types', () => {
    expect(
      registry.getConfig(NotificationType.WISHLIST_PRODUCT_UNAVAILABLE),
    ).toBeDefined();
    expect(
      registry.getConfig(NotificationType.WISHLIST_PRODUCT_AVAILABLE),
    ).toBeDefined();
  });

  it('validates wishlist payloads against the store service payload shape', () => {
    const unavailableConfig = registry.getConfig(
      NotificationType.WISHLIST_PRODUCT_UNAVAILABLE,
    );
    const availableConfig = registry.getConfig(
      NotificationType.WISHLIST_PRODUCT_AVAILABLE,
    );
    const payload = {
      productId: 'product-123',
      productName: 'Linen Wrap Dress',
      brandName: 'Threadly Studio',
    };

    expect(unavailableConfig?.schema.validate(payload).error).toBeUndefined();
    expect(availableConfig?.schema.validate(payload).error).toBeUndefined();
    expect(
      unavailableConfig?.schema.validate({ productName: 'Linen Wrap Dress' })
        .error,
    ).toBeDefined();
    expect(
      availableConfig?.schema.validate({ productName: 'Linen Wrap Dress' })
        .error,
    ).toBeDefined();
  });

  it('formats wishlist notifications with meaningful product and brand copy', () => {
    const unavailableConfig = registry.getConfig(
      NotificationType.WISHLIST_PRODUCT_UNAVAILABLE,
    );
    const availableConfig = registry.getConfig(
      NotificationType.WISHLIST_PRODUCT_AVAILABLE,
    );
    const notification = {
      payload: {
        productId: 'product-123',
        productName: 'Linen Wrap Dress',
        brandName: 'Threadly Studio',
      },
    };

    expect(unavailableConfig?.formatter(notification)).toBe(
      'Linen Wrap Dress from Threadly Studio is no longer available from your wishlist',
    );
    expect(availableConfig?.formatter(notification)).toBe(
      'Linen Wrap Dress from Threadly Studio is available again from your wishlist',
    );
  });
});
