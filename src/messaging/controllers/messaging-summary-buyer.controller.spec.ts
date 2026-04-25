import { MessagingSummaryBuyerController } from './messaging-summary-buyer.controller';

describe('MessagingSummaryBuyerController', () => {
  const messaging = {
    getBulkSummariesForCustomOrdersBuyer: jest.fn(),
    getBulkSummariesForOrdersBuyer: jest.fn(),
  } as any;

  const controller = new MessagingSummaryBuyerController(messaging);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards custom-order bulk summary requests to service', async () => {
    messaging.getBulkSummariesForCustomOrdersBuyer.mockResolvedValue({ items: [] });

    const req = { user: { id: 'buyer_1' } } as any;
    const dto = { contextIds: ['co_1', 'co_2'], includeUnreadCount: 'true' } as any;

    const result = await controller.customOrderSummaries(req, dto);

    expect(messaging.getBulkSummariesForCustomOrdersBuyer).toHaveBeenCalledWith('buyer_1', dto);
    expect(result).toEqual({ items: [] });
  });

  it('forwards order bulk summary requests to service', async () => {
    messaging.getBulkSummariesForOrdersBuyer.mockResolvedValue({ items: [] });

    const req = { user: { id: 'buyer_1' } } as any;
    const dto = { contextIds: ['o_1'], includeUnreadCount: 'false' } as any;

    const result = await controller.orderSummaries(req, dto);

    expect(messaging.getBulkSummariesForOrdersBuyer).toHaveBeenCalledWith('buyer_1', dto);
    expect(result).toEqual({ items: [] });
  });
});
