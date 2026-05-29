import { MessagingSummaryBrandController } from './messaging-summary-brand.controller';

describe('MessagingSummaryBrandController', () => {
  const messaging = {
    getBulkSummariesForCustomOrdersBrand: jest.fn(),
    getBulkSummariesForOrdersBrand: jest.fn(),
  } as any;

  const controller = new MessagingSummaryBrandController(messaging);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards brand custom-order bulk summary requests to service', async () => {
    messaging.getBulkSummariesForCustomOrdersBrand.mockResolvedValue({
      items: [],
    });

    const req = { user: { id: 'brand_user_1' } } as any;
    const dto = {
      contextIds: ['co_1', 'co_2'],
      includeUnreadCount: 'true',
    } as any;

    const result = await controller.customOrderSummaries(req, 'brand_1', dto);

    expect(messaging.getBulkSummariesForCustomOrdersBrand).toHaveBeenCalledWith(
      'brand_user_1',
      'brand_1',
      dto,
    );
    expect(result).toEqual({ items: [] });
  });

  it('forwards brand order bulk summary requests to service', async () => {
    messaging.getBulkSummariesForOrdersBrand.mockResolvedValue({ items: [] });

    const req = { user: { id: 'brand_user_1' } } as any;
    const dto = { contextIds: ['o_1'], includeUnreadCount: 'false' } as any;

    const result = await controller.orderSummaries(req, 'brand_1', dto);

    expect(messaging.getBulkSummariesForOrdersBrand).toHaveBeenCalledWith(
      'brand_user_1',
      'brand_1',
      dto,
    );
    expect(result).toEqual({ items: [] });
  });
});
