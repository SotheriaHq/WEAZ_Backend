import { OrderSlaCronService } from '../order/order-sla.cron.service';
import { ReviewsService } from '../reviews/reviews.service';
import { SizeFitService } from '../users/size-fit.service';
import { CollectionSchedulerService } from '../collections/collection-scheduler.service';
import { PhysicalVerificationCronService } from '../brand-verification/physical-verification-cron.service';
import { BrandVerificationCronService } from '../brand-verification/brand-verification-cron.service';
import { FeaturedAutoRemovalService } from '../admin/featured/featured-auto-removal.service';
import { StoreService } from '../store/store.service';

describe('scheduled event notification batching', () => {
  const notifications = () => ({
    create: jest.fn(),
    createEvents: jest
      .fn()
      .mockImplementation(async (events) =>
        events.map(() => ({ status: 'fulfilled', value: {} })),
      ),
  });

  it('groups bag reminders by shopper and preserves oldest product, quantities, target and dedupe', async () => {
    const prisma = {
      cartItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            userId: 'first',
            quantity: 2,
            updatedAt: new Date('2026-01-02'),
            product: { id: 'newer', name: 'Newer' },
          },
          {
            userId: 'first',
            quantity: 1,
            updatedAt: new Date('2026-01-01'),
            product: { id: 'oldest', name: 'Oldest' },
          },
          {
            userId: 'second',
            quantity: 1,
            updatedAt: new Date('2026-01-01'),
            product: { id: 'only', name: 'Only item' },
          },
        ]),
      },
    };
    const notify = notifications();
    notify.createEvents.mockResolvedValueOnce([
      { status: 'rejected', reason: new Error('recipient unavailable') },
      { status: 'fulfilled', value: {} },
    ]);
    const service: any = new StoreService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      notify as any,
    );
    const warn = jest
      .spyOn(service.logger, 'warn')
      .mockImplementation(() => {});
    await expect(service.handleBagCheckoutReminders()).resolves.toBeUndefined();
    expect(notify.create).not.toHaveBeenCalled();
    expect(notify.createEvents).toHaveBeenCalledTimes(1);
    const events = notify.createEvents.mock.calls[0][0];
    expect(events[0]).toMatchObject({
      recipientId: 'first',
      type: 'BAG_CHECKOUT_REMINDER',
      opts: {
        dedupeMs: 2 * 3600000,
        payload: {
          itemCount: 3,
          topItemTitle: 'Oldest',
          otherItemCount: 2,
          targetUrl: '/bag',
        },
      },
    });
    expect(events[0].opts.payload.message).toContain('and 2 more items');
    expect(events[1]).toMatchObject({
      recipientId: 'second',
      opts: {
        payload: {
          itemCount: 1,
          otherItemCount: 0,
          message:
            'Only item is still in your bag. Check out soon before it sells out or the price changes.',
        },
        target: { type: 'SYSTEM', preview: 'Bag' },
      },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(prisma.cartItem.findMany.mock.calls[0][0]).toMatchObject({
      take: 500,
      where: {
        product: {
          isActive: true,
          deletedAt: null,
          archivedAt: null,
          publicationStatus: 'PUBLISHED',
        },
      },
    });
  });

  it('does no bag notification work for empty carts or an absent notification service', async () => {
    const prisma = { cartItem: { findMany: jest.fn().mockResolvedValue([]) } };
    const notify = notifications();
    const service = new StoreService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      notify as any,
    );
    await service.handleBagCheckoutReminders();
    expect(notify.createEvents).not.toHaveBeenCalled();
    (service as any).notifications = undefined;
    await service.handleBagCheckoutReminders();
    expect(prisma.cartItem.findMany).toHaveBeenCalledTimes(1);
  });

  it('batches out-of-stock lifecycle events and only stamps successful reminders behind current product guards', async () => {
    const product = (id: string) => ({
      id,
      name: `Product ${id}`,
      ownerId: 'owner',
      customOrderOutOfStockDiscontinueAt: new Date(Date.now() + 2 * 86400000),
    });
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([product('discontinued'), product('changed')])
        .mockResolvedValueOnce([
          product('failed'),
          product('reminded'),
          { ...product('missing-owner'), ownerId: null },
        ]),
      product: {
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValue({ count: 1 }),
      },
    };
    const notify = notifications();
    notify.createEvents
      .mockResolvedValueOnce([{ status: 'fulfilled', value: {} }])
      .mockResolvedValueOnce([
        { status: 'rejected', reason: new Error('recipient unavailable') },
        { status: 'fulfilled', value: {} },
      ]);
    const service: any = new StoreService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      notify as any,
    );
    jest.spyOn(service.logger, 'warn').mockImplementation(() => {});
    await service.handleCustomOrderOutOfStockLifecycle();
    expect(notify.create).not.toHaveBeenCalled();
    expect(notify.createEvents).toHaveBeenCalledTimes(2);
    const discontinued = notify.createEvents.mock.calls[0][0];
    expect(discontinued).toHaveLength(1);
    expect(discontinued[0]).toMatchObject({
      recipientId: 'owner',
      type: 'ADMIN_ACTION',
      opts: {
        payload: {
          productId: 'discontinued',
          targetUrl: '/studio/products/discontinued',
        },
        target: { type: 'PRODUCT', id: 'discontinued' },
        dedupeMs: 6 * 3600000,
      },
    });
    expect(discontinued[0].opts.payload.message).toContain(
      'discontinued from the market',
    );
    const reminders = notify.createEvents.mock.calls[1][0];
    expect(reminders.map((event) => event.opts.payload.productId)).toEqual([
      'failed',
      'reminded',
    ]);
    expect(reminders[1].opts.payload.message).toContain('within 2 days');
    expect(prisma.product.updateMany).toHaveBeenCalledTimes(3);
    expect(prisma.product.updateMany.mock.calls[2][0]).toEqual({
      where: {
        id: { in: ['reminded'] },
        deletedAt: null,
        archivedAt: null,
        isActive: true,
        customOrderEnabled: true,
        totalStock: { lte: 0 },
        customOrderOutOfStockTriggeredAt: { not: null },
        customOrderOutOfStockDiscontinueAt: { gt: expect.any(Date) },
      },
      data: { customOrderOutOfStockReminderSentAt: expect.any(Date) },
    });
  });

  it('does not stamp out-of-stock reminders when delivery fails or notifications are unavailable', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'failed', name: 'Failed', ownerId: 'owner' },
        ]),
      product: {
        updateMany: jest.fn(),
      },
    };
    const notify = notifications();
    notify.createEvents.mockResolvedValue([
      { status: 'rejected', reason: new Error('policy unavailable') },
    ]);
    const service: any = new StoreService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      notify as any,
    );
    jest.spyOn(service.logger, 'warn').mockImplementation(() => {});
    await service.handleCustomOrderOutOfStockLifecycle();
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'failed', name: 'Failed', ownerId: 'owner' },
      ]);
    service.notifications = undefined;
    await service.handleCustomOrderOutOfStockLifecycle();
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
  });

  it('keeps both sides of visit reminders and marks the selected window in one write', async () => {
    const rows = [
      {
        id: 'visit1',
        brandId: 'brand1',
        brand: { name: 'One', ownerId: 'owner1' },
        assignedAgentId: 'agent',
        selectedSlotAt: new Date(),
      },
      {
        id: 'visit2',
        brandId: 'brand2',
        brand: { name: 'Two', ownerId: 'owner2' },
        assignedAgentId: null,
        selectedSlotAt: new Date(),
      },
    ];
    const prisma = {
      brandPhysicalVerification: {
        findMany: jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]),
        updateMany: jest.fn(),
      },
    };
    const notify = notifications();
    const service = new PhysicalVerificationCronService(
      prisma as any,
      notify as any,
    );
    await (service as any).remindBeforeVisit();
    expect(notify.create).not.toHaveBeenCalled();
    expect(notify.createEvents).toHaveBeenCalledTimes(1);
    const events = notify.createEvents.mock.calls[0][0];
    expect(events.map((event) => event.recipientId)).toEqual([
      'owner1',
      'agent',
      'owner2',
    ]);
    expect(events[1].opts.payload.targetUrl).toBe(
      '/admin/verification/visits/visit1',
    );
    expect(events[2].opts.payload.brandId).toBe('brand2');
    expect(prisma.brandPhysicalVerification.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['visit1', 'visit2'] } },
      data: { reminderDayBeforeAt: expect.any(Date) },
    });
  });

  it('keeps response-due routing for the brand and assigned agent separate', async () => {
    const brand = {
      id: 'brandVisit',
      brandId: 'b1',
      brand: { ownerId: 'owner', name: 'One' },
    };
    const agent = {
      id: 'agentVisit',
      brandId: 'b2',
      brand: { ownerId: 'other', name: 'Two' },
      assignedAgentId: 'agent',
    };
    const prisma = {
      brandPhysicalVerification: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([brand])
          .mockResolvedValueOnce([agent]),
        updateMany: jest.fn(),
      },
    };
    const notify = notifications();
    await (
      new PhysicalVerificationCronService(prisma as any, notify as any) as any
    ).nudgeAwaitingReply();
    expect(notify.createEvents.mock.calls[0][0][0]).toMatchObject({
      recipientId: 'owner',
      opts: { payload: { owes: 'BRAND', targetUrl: '/studio/verification' } },
    });
    expect(notify.createEvents.mock.calls[1][0][0]).toMatchObject({
      recipientId: 'agent',
      opts: {
        payload: {
          owes: 'AGENT',
          targetUrl: '/admin/verification/visits/agentVisit',
        },
      },
    });
    expect(prisma.brandPhysicalVerification.updateMany).toHaveBeenCalledTimes(
      2,
    );
  });

  it('preserves failed-recipient handling for physical reminders without losing the rest', async () => {
    const notify = notifications();
    notify.createEvents.mockResolvedValue([
      { status: 'rejected', reason: new Error('recipient unavailable') },
      { status: 'fulfilled', value: {} },
    ]);
    const service = new PhysicalVerificationCronService(
      {} as any,
      notify as any,
    );
    const warn = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    await expect(
      (service as any).sendEvents([
        { recipientId: 'a', type: 'VERIFICATION_VISIT_OVERDUE' },
        { recipientId: 'b', type: 'VERIFICATION_VISIT_OVERDUE' },
      ]),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not advance a verification nudge counter after its notification fails', async () => {
    const prisma = {
      brand: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'brand',
            ownerId: 'owner',
            name: 'One',
            owner: { email: null },
          },
        ]),
        update: jest.fn(),
      },
    };
    const notify = notifications();
    notify.createEvents.mockResolvedValue([
      { status: 'rejected', reason: new Error('policy unavailable') },
    ]);
    const service = new BrandVerificationCronService(
      prisma as any,
      notify as any,
      { getAppName: () => 'WIEZ' } as any,
    );
    await expect(service.sendVerificationNudges()).rejects.toThrow(
      'policy unavailable',
    );
    expect(prisma.brand.update).not.toHaveBeenCalled();
  });

  it('hydrates one owner for all suspended-brand featured entities and preserves individual targets', async () => {
    const items = [
      { id: 'f1', entityType: 'DESIGN', entityId: 'design' },
      { id: 'f2', entityType: 'PRODUCT', entityId: 'product' },
    ];
    const tx = {
      featuredItem: { updateMany: jest.fn() },
      brand: { update: jest.fn() },
    };
    const prisma = {
      featuredItem: { findMany: jest.fn().mockResolvedValue(items) },
      brand: { findUnique: jest.fn().mockResolvedValue({ ownerId: 'owner' }) },
      $transaction: jest.fn(async (work) => work(tx)),
    };
    const notify = notifications();
    await new FeaturedAutoRemovalService(
      prisma as any,
      notify as any,
    ).onBrandOwnerSuspended('brand');
    expect(prisma.brand.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.featuredItem.updateMany).toHaveBeenCalledTimes(1);
    expect(notify.create).not.toHaveBeenCalled();
    expect(
      notify.createEvents.mock.calls[0][0].map((event) => event.opts.target),
    ).toEqual([
      { type: 'COLLECTION', id: 'design' },
      { type: 'PRODUCT', id: 'product' },
    ]);
  });
  it('retains reviewed/disputed exclusions and per-row delivery errors in review reminders', async () => {
    const rows = ['reviewed', 'disputed', 'good', 'failed'].map((id) => ({
      id,
      buyerId: 'buyer',
      productId: id,
      orderId: `order-${id}`,
      nameAtPurchase: id,
    }));
    const prisma = {
      orderItem: {
        findMany: jest.fn().mockResolvedValue(rows),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      productReview: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ userId: 'buyer', productId: 'reviewed' }]),
      },
      sizingDispute: {
        findMany: jest.fn().mockResolvedValue([{ orderItemId: 'disputed' }]),
      },
    };
    const notify = notifications();
    notify.createEvents.mockResolvedValue([
      { status: 'fulfilled', value: {} },
      { status: 'rejected', reason: new Error('delivery unavailable') },
    ]);
    const service = Object.assign(Object.create(ReviewsService.prototype), {
      prisma,
      notifications: notify,
      assertFeatureEnabled: jest.fn(),
      getReminderDelayDays: () => 14,
      observability: { recordReminderRun: jest.fn() },
      logger: { log: jest.fn() },
    });
    expect(await service.processDueReviewReminders()).toEqual({
      processed: 4,
      sent: 1,
      skipped: 2,
      failed: 1,
    });
    expect(notify.create).not.toHaveBeenCalled();
    expect(
      notify.createEvents.mock.calls[0][0].map(
        (event) => event.opts.payload.orderItemId,
      ),
    ).toEqual(['good', 'failed']);
    expect(prisma.orderItem.update).toHaveBeenCalledTimes(1);
    expect(prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'failed' },
      data: { reviewReminderLastError: 'delivery unavailable' },
    });
    expect(prisma.orderItem.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.orderItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['good'] } },
      data: {
        reviewReminderSentAt: expect.any(Date),
        reviewReminderLastError: null,
      },
    });
  });

  it('advances only successfully handled shopper fitting reminders and retains the fittings link', async () => {
    const prisma = {
      userSizeFitProfile: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'p1', userId: 'u1', requireUpdateEveryDays: 14 },
          { id: 'p2', userId: 'u2', requireUpdateEveryDays: 21 },
        ]),
        updateMany: jest.fn(),
      },
    };
    const notify = notifications();
    notify.createEvents.mockResolvedValue([
      { status: 'fulfilled', value: {} },
      { status: 'rejected', reason: new Error('policy unavailable') },
    ]);
    const service = Object.assign(Object.create(SizeFitService.prototype), {
      prisma,
      notifications: notify,
      logger: { warn: jest.fn() },
    });
    expect(await service.sendDueUpdateReminders()).toBe(1);
    expect(prisma.userSizeFitProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ user: { is: { type: 'REGULAR' } } }),
      }),
    );
    expect(prisma.userSizeFitProfile.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.userSizeFitProfile.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1'] } },
      data: { nextReminderAt: expect.any(Date) },
    });
    expect(notify.createEvents.mock.calls[0][0][0].opts.payload.targetUrl).toBe(
      '/profile?tab=fits',
    );
  });

  it('batches draft warnings without mixing titles, expiry or owner identities', async () => {
    const drafts = [
      {
        id: 'd1',
        ownerId: 'u1',
        title: 'One',
        lastActivityAt: new Date('2026-10-01T00:00:00Z'),
        _count: { medias: 2, products: 0 },
      },
      {
        id: 'd2',
        ownerId: 'u2',
        title: 'Two',
        lastActivityAt: new Date('2026-10-02T00:00:00Z'),
        _count: { medias: 3, products: 0 },
      },
    ];
    const prisma = {
      collection: { findMany: jest.fn().mockResolvedValue(drafts) },
    };
    const notify = notifications();
    const service = new CollectionSchedulerService(
      prisma as any,
      notify as any,
      {} as any,
      {} as any,
    );
    expect(await (service as any).sendExpiryWarnings(new Date(), 7)).toBe(2);
    expect(notify.create).not.toHaveBeenCalled();
    const events = notify.createEvents.mock.calls[0][0];
    expect(events[0]).toMatchObject({
      recipientId: 'u1',
      opts: { payload: { collectionTitle: 'One', mediaCount: 2 } },
    });
    expect(events[1]).toMatchObject({
      recipientId: 'u2',
      opts: { payload: { collectionTitle: 'Two', mediaCount: 3 } },
    });
    expect(events[0].opts.payload.expiryDate).not.toBe(
      events[1].opts.payload.expiryDate,
    );
  });

  it('batches fulfilment reminders and keeps their exact order links and realtime updates', async () => {
    const orders = ['one', 'two', 'closed'].map((id) => ({
      id,
      status: 'PROCESSING',
      paidAt: new Date(),
      brand: { ownerId: `owner-${id}` },
    }));
    const prisma = { order: { findMany: jest.fn().mockResolvedValue(orders) } };
    const notify = { ...notifications(), emitOrderUpdated: jest.fn() };
    const service: any = new OrderSlaCronService(
      prisma as any,
      notify as any,
      {} as any,
    );
    service.isEnabled = () => true;
    service.computeOrderElapsed = (order) => ({
      elapsedHours: 24,
      businessMode: order.id === 'closed',
      currentlyOpen: order.id !== 'closed',
    });
    await service.remindBrandFulfilment();
    expect(notify.create).not.toHaveBeenCalled();
    const events = notify.createEvents.mock.calls[0][0];
    expect(events.map((event) => event.opts.payload.targetUrl)).toEqual([
      '/orders/one',
      '/orders/two',
    ]);
    expect(notify.emitOrderUpdated).toHaveBeenCalledTimes(2);
  });

  it('keeps overdue escalation deduplicated per order and separates each order payload', async () => {
    const orders = ['one', 'two'].map((id) => ({
      id,
      status: 'PROCESSING',
      paidAt: new Date(),
      buyerId: 'buyer',
      brand: { ownerId: 'owner' },
    }));
    const prisma = {
      order: { findMany: jest.fn().mockResolvedValue(orders) },
      user: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'admin' }, { id: 'owner' }]),
      },
    };
    const notify = { ...notifications(), emitOrderUpdated: jest.fn() };
    const refund = { initiateRefund: jest.fn() };
    const service: any = new OrderSlaCronService(
      prisma as any,
      notify as any,
      refund as any,
    );
    service.isEnabled = () => true;
    service.isAutoCancelEnabled = () => false;
    service.computeOrderElapsed = () => ({
      elapsedHours: 72,
      businessMode: false,
      currentlyOpen: true,
    });
    await service.escalateOrCloseOverdue();
    const events = notify.createEvents.mock.calls[0][0];
    expect(
      events.map((event) => [event.recipientId, event.opts.payload.orderId]),
    ).toEqual([
      ['owner', 'one'],
      ['admin', 'one'],
      ['owner', 'two'],
      ['admin', 'two'],
    ]);
    expect(refund.initiateRefund).not.toHaveBeenCalled();
  });

  it('keeps cancellation/refund work guarded and notifies only the winning order update', async () => {
    const orders = ['winner', 'already-shipped'].map((id) => ({
      id,
      status: 'PROCESSING',
      paidAt: new Date(),
      buyerId: 'buyer',
      brand: { ownerId: 'owner' },
    }));
    const tx = {
      order: {
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
      },
    };
    const prisma = {
      order: { findMany: jest.fn().mockResolvedValue(orders) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'admin' }]) },
      $transaction: jest.fn(async (work) => work(tx)),
    };
    const notify = { ...notifications(), emitOrderUpdated: jest.fn() };
    const refund = { initiateRefund: jest.fn() };
    const service: any = new OrderSlaCronService(
      prisma as any,
      notify as any,
      refund as any,
    );
    service.isEnabled = () => true;
    service.isAutoCancelEnabled = () => true;
    service.computeOrderElapsed = () => ({
      elapsedHours: 90,
      businessMode: false,
      currentlyOpen: true,
    });
    await service.escalateOrCloseOverdue();
    expect(refund.initiateRefund).toHaveBeenCalledTimes(1);
    expect(refund.initiateRefund).toHaveBeenCalledWith(tx, {
      orderId: 'winner',
      reason: 'SLA_FULFILLMENT_TIMEOUT',
      trigger: 'SLA_TIMEOUT',
    });
    expect(
      notify.createEvents.mock.calls[0][0].every(
        (event) => event.opts.payload.orderId === 'winner',
      ),
    ).toBe(true);
    expect(notify.emitOrderUpdated).toHaveBeenCalledTimes(1);
  });

  it('does no SLA reads or fanout when the engine is disabled', async () => {
    const prisma = {
      order: { findMany: jest.fn() },
      user: { findMany: jest.fn() },
    };
    const notify = { ...notifications(), emitOrderUpdated: jest.fn() };
    const service: any = new OrderSlaCronService(
      prisma as any,
      notify as any,
      {} as any,
    );
    service.isEnabled = () => false;
    await service.remindBrandFulfilment();
    await service.escalateOrCloseOverdue();
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(notify.createEvents).not.toHaveBeenCalled();
  });

  it('continues after one fulfilment-recipient failure and skips missing owner/payment dates', async () => {
    const orders = [
      {
        id: 'failed',
        paidAt: new Date(),
        status: 'PENDING',
        brand: { ownerId: 'owner-one' },
      },
      {
        id: 'good',
        paidAt: new Date(),
        status: 'PROCESSING',
        brand: { ownerId: 'owner-two' },
      },
      {
        id: 'unpaid-date',
        paidAt: null,
        status: 'PENDING',
        brand: { ownerId: 'owner-three' },
      },
      { id: 'no-owner', paidAt: new Date(), status: 'PENDING', brand: null },
    ];
    const prisma = { order: { findMany: jest.fn().mockResolvedValue(orders) } };
    const notify = { ...notifications(), emitOrderUpdated: jest.fn() };
    notify.createEvents.mockResolvedValue([
      { status: 'rejected', reason: new Error('policy unavailable') },
      { status: 'fulfilled', value: {} },
    ]);
    const service: any = new OrderSlaCronService(
      prisma as any,
      notify as any,
      {} as any,
    );
    service.isEnabled = () => true;
    service.computeOrderElapsed = () => ({
      elapsedHours: 24,
      businessMode: false,
      currentlyOpen: true,
    });
    await service.remindBrandFulfilment();
    expect(
      notify.createEvents.mock.calls[0][0].map((event) => event.recipientId),
    ).toEqual(['owner-one', 'owner-two']);
    expect(notify.emitOrderUpdated).toHaveBeenCalledTimes(1);
    expect(notify.emitOrderUpdated).toHaveBeenCalledWith(['owner-two'], {
      kind: 'STANDARD',
      orderId: 'good',
      status: 'PROCESSING',
    });
  });

  it('keeps escalation inside its one-hour window and excludes frozen closed-business hours', async () => {
    const rows = [
      {
        id: 'window',
        elapsedHours: 72.5,
        businessMode: false,
        currentlyOpen: true,
      },
      {
        id: 'early',
        elapsedHours: 71.9,
        businessMode: false,
        currentlyOpen: true,
      },
      {
        id: 'late',
        elapsedHours: 73,
        businessMode: false,
        currentlyOpen: true,
      },
      {
        id: 'closed',
        elapsedHours: 72.5,
        businessMode: true,
        currentlyOpen: false,
      },
    ];
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue(
          rows.map((row) => ({
            ...row,
            paidAt: new Date(),
            brand: { ownerId: 'owner' },
          })),
        ),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const notify = { ...notifications(), emitOrderUpdated: jest.fn() };
    const service: any = new OrderSlaCronService(
      prisma as any,
      notify as any,
      {} as any,
    );
    service.isEnabled = () => true;
    service.isAutoCancelEnabled = () => false;
    service.computeOrderElapsed = (order) => order;
    await service.escalateOrCloseOverdue();
    expect(
      notify.createEvents.mock.calls[0][0].map(
        (event) => event.opts.payload.orderId,
      ),
    ).toEqual(['window']);
  });
});
