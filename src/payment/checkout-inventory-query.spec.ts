import { randomUUID } from 'node:crypto';
import {
  lockCheckoutProducts,
  releaseCheckoutReservations,
} from './checkout-inventory-query';
import { PaymentService } from './payment.service';

const parse = (value: any) => (value ? { ...value } : null);
function fixture() {
  const id = randomUUID();
  const product = {
    id,
    name: 'Tee',
    totalStock: 7,
    sizeStock: { M: 4, S: 3 },
    trackInventory: true,
    allowBackorders: false,
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    product: {
      findMany: jest.fn().mockResolvedValue([product]),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    productVariant: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    inventoryReservation: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return { id, product, tx };
}
describe('checkout inventory bulk reads', () => {
  it('locks in sorted order and hydrates a deduplicated batch only after locking', async () => {
    const { id, tx } = fixture();
    await lockCheckoutProducts(tx as any, [id, id.toUpperCase()]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0][0].text).toContain(
      'ORDER BY "_id" FOR UPDATE',
    );
    expect(tx.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [id] } } }),
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.product.findMany.mock.invocationCallOrder[0],
    );
    expect(tx.product.findUnique).not.toHaveBeenCalled();
  });
  it('returns 40 same-product reservations in one joined update and sums sizes before writing', async () => {
    const { id, tx } = fixture();
    const variantId = randomUUID();
    const rows = Array.from({ length: 40 }, () => ({
      id: randomUUID(),
      productId: id,
      productVariantId: variantId,
      quantity: 2,
      reservedSize: 'M',
    }));
    await releaseCheckoutReservations(
      tx as any,
      rows,
      new Date(),
      'FAILED',
      parse,
    );
    expect(tx.product.findMany).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    const productUpdate = tx.$executeRaw.mock.calls[0][0];
    expect(productUpdate.values).toContain(80);
    expect(productUpdate.values).toContain(JSON.stringify({ M: 84, S: 3 }));
    expect(tx.inventoryReservation.updateMany).toHaveBeenCalledTimes(1);
  });
  it('skips missing products and unknown size buckets without inventing inventory', async () => {
    const { id, tx } = fixture();
    const rows = [
      {
        id: randomUUID(),
        productId: id,
        productVariantId: null,
        quantity: 2,
        reservedSize: 'XL',
      },
      {
        id: randomUUID(),
        productId: randomUUID(),
        productVariantId: null,
        quantity: 3,
        reservedSize: 'M',
      },
    ];
    await releaseCheckoutReservations(
      tx as any,
      rows,
      new Date(),
      'FAILED',
      parse,
    );
    expect(tx.$executeRaw.mock.calls[0][0].values).toContain(
      JSON.stringify({ M: 4, S: 3 }),
    );
    expect(
      tx.inventoryReservation.updateMany.mock.calls[0][0].where.id.in,
    ).toEqual([rows[0].id]);
  });
  it('uses bounded pages and performs no query for an empty batch', async () => {
    const { tx } = fixture();
    await lockCheckoutProducts(
      tx as any,
      Array.from({ length: 501 }, () => randomUUID()),
    );
    expect(tx.product.findMany).toHaveBeenCalledTimes(2);
    tx.$queryRaw.mockClear();
    await releaseCheckoutReservations(
      tx as any,
      [],
      new Date(),
      'FAILED',
      parse,
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('deducts repeated product lines from the current locked state and rejects overselling', async () => {
    const { id, product, tx } = fixture();
    const service = Object.create(PaymentService.prototype);
    const inventory = new Map([[id, product]]);
    const line = {
      productId: id,
      productName: 'Tee',
      reserveInventory: true,
      quantity: 3,
      selectedSize: 'M',
    };
    await service.reserveUnifiedStandardLineInventory(
      tx,
      randomUUID(),
      randomUUID(),
      line,
      new Date(),
      inventory,
    );
    expect(product.totalStock).toBe(4);
    expect(product.sizeStock).toEqual({ M: 1, S: 3 });
    await expect(
      service.reserveUnifiedStandardLineInventory(
        tx,
        randomUUID(),
        randomUUID(),
        line,
        new Date(),
        inventory,
      ),
    ).rejects.toThrow('Only 1 left');
    expect(tx.product.findUnique).not.toHaveBeenCalled();
    expect(tx.product.update).toHaveBeenCalledTimes(1);
  });
});
