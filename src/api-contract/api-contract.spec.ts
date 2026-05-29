import { readFileSync } from 'fs';
import { join } from 'path';

const readSource = (relativePath: string) =>
  readFileSync(join(__dirname, '..', relativePath), 'utf8');

describe('MVP API route contract', () => {
  it('exposes canonical own-profile update without a client-supplied user id', () => {
    const usersController = readSource('users/user-profile.controller.ts');

    expect(usersController).toContain("@Patch('me/profile')");
    expect(usersController).toContain('updateOwnProfile');
  });

  it('keeps the legacy auth profile update route protected for compatibility only', () => {
    const authController = readSource('auth/auth.controller.ts');

    expect(authController).toContain("@Patch('update-profile/:id')");
    expect(authController).toContain('req.user.id !== id');
    expect(authController).toContain('Role.SuperAdmin');
  });

  it('exposes canonical buyer order, public storefront, payment, upload, market, messaging, and notification routes', () => {
    const storeController = readSource('store/store.controller.ts');
    const paymentController = readSource('payment/payment.controller.ts');
    const uploadController = readSource('upload/upload.controller.ts');
    const marketSignalController = readSource('market/market-signal.controller.ts');
    const messagingController = readSource(
      'messaging/controllers/messaging-inbox.controller.ts',
    );
    const notificationsController = readSource(
      'notifications/notifications.controller.ts',
    );
    const storeCollectionsController = readSource(
      'collections/store-collections.controller.ts',
    );

    expect(storeController).toContain("@Get(['orders', 'store/orders'])");
    expect(storeController).toContain("@Get('public/storefronts/:slug')");
    expect(paymentController).toContain("@Post('initialize-unified')");
    expect(paymentController).toContain("@Post('verify')");
    expect(uploadController).toContain("@Controller('uploads')");
    expect(marketSignalController).toContain("@Post('signals/batch')");
    expect(messagingController).toContain("@Get('inbox')");
    expect(messagingController).toContain("@Get('threads/:threadId/messages')");
    expect(notificationsController).toContain("@Get('unread-count')");
    expect(notificationsController).toContain("@Post('push-tokens')");
    expect(storeCollectionsController).toContain("@Controller('store-collections')");
  });
});
