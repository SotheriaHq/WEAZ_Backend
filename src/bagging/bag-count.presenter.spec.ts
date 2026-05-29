import { BagCountPresenter } from './bag-count.presenter';

describe('BagCountPresenter', () => {
  const prisma = {
    cartItem: { findMany: jest.fn() },
    customOrderCheckoutSession: { count: jest.fn() },
  } as any;
  const presenter = new BagCountPresenter(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns standard quantity only', async () => {
    prisma.cartItem.findMany.mockResolvedValue([
      { quantity: 2 },
      { quantity: 3 },
    ]);
    prisma.customOrderCheckoutSession.count.mockResolvedValue(0);

    await expect(presenter.getCount('buyer_1')).resolves.toEqual({
      standardQuantity: 5,
      customLineCount: 0,
      combinedCount: 5,
    });
  });

  it('returns custom count only', async () => {
    prisma.cartItem.findMany.mockResolvedValue([]);
    prisma.customOrderCheckoutSession.count.mockResolvedValue(2);

    await expect(presenter.getCount('buyer_1')).resolves.toEqual({
      standardQuantity: 0,
      customLineCount: 2,
      combinedCount: 2,
    });
  });

  it('returns combined count', async () => {
    prisma.cartItem.findMany.mockResolvedValue([
      { quantity: 1 },
      { quantity: 4 },
    ]);
    prisma.customOrderCheckoutSession.count.mockResolvedValue(3);

    await expect(presenter.getCount('buyer_1')).resolves.toEqual({
      standardQuantity: 5,
      customLineCount: 3,
      combinedCount: 8,
    });
  });
});
