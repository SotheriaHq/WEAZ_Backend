import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), 'utf8');

describe('store lifecycle sync contract', () => {
  it('keeps bag, wishlist, measurement, and order lifecycle state user-scoped on canonical backend routes', () => {
    const controller = read('src/store/store.controller.ts');
    const service = read('src/store/store.service.ts');
    const schema = read('prisma/schema.prisma');

    expect(controller).toContain("@Post(['cart', 'store/cart'])");
    expect(controller).toContain('return this.storeService.addToCart(req.user.id, dto)');
    expect(controller).toContain("@Get(['cart', 'store/cart'])");
    expect(controller).toContain('return this.storeService.getCart(req.user.id)');
    expect(controller).toContain("@Patch(['cart/:itemId', 'store/cart/:itemId'])");
    expect(controller).toContain('return this.storeService.updateCartItem(req.user.id, itemId, dto)');
    expect(controller).toContain("@Delete(['cart/:itemId', 'store/cart/:itemId'])");
    expect(controller).toContain('return this.storeService.removeFromCart(req.user.id, itemId)');
    expect(controller).toContain("@Delete(['cart', 'store/cart'])");
    expect(controller).toContain('return this.storeService.clearCart(req.user.id)');

    expect(controller).toContain("@Post(['wishlist', 'store/wishlist'])");
    expect(controller).toContain('return this.storeService.addToWishlist(req.user.id, dto)');
    expect(controller).toContain("@Delete(['wishlist/:productId', 'store/wishlist/:productId'])");
    expect(controller).toContain('return this.storeService.removeFromWishlist(req.user.id, productId)');
    expect(controller).toContain("@Get(['wishlist', 'store/wishlist'])");
    expect(controller).toContain('return this.storeService.getWishlist(');
    expect(controller).toContain('req.user.id,');
    expect(controller).toContain("@Get(['orders', 'store/orders'])");
    expect(controller).toContain('return this.storeService.getMyOrders(');
    expect(controller).toContain("@Get(['orders/:orderId', 'store/orders/:orderId'])");
    expect(controller).toContain('return this.storeService.getMyOrder(req.user.id, orderId)');

    expect(service).toContain('where: { userId }');
    expect(service).toContain('where: { id: cartItemId, userId }');
    expect(service).toContain('where: { userId_productId: { userId, productId: dto.productId } }');
    expect(service).toContain('where: { userId, productId }');
    expect(service).toContain('sizeFitData: sizingPayload.sizeFitData');
    expect(service).toContain('requiredMeasurementKeys: sizingPayload.requiredMeasurementKeys');
    expect(service).toContain('sizeRecommendationSnapshot: recommendationSnapshot');

    expect(schema).toContain('model CartItem');
    expect(schema).toContain('@@unique([userId, productId, selectedSize, selectedColor])');
    expect(schema).toContain('sizeFitData                Json?');
    expect(schema).toContain('requiredMeasurementKeys    String[]');
    expect(schema).toContain('model WishlistItem');
    expect(schema).toContain('@@unique([userId, productId])');
    expect(schema).toContain('model UserSizeFitProfile');
    expect(schema).toContain('userId                   String                               @unique');
    expect(schema).toContain('model OrderItem');
    expect(schema).toContain('sizeFitSnapshot            Json?');
  });
});
