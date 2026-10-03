import { CustomOrderStatus } from '@prisma/client';

import {
  resolveOrderSchedule,
  SCHEDULE_POLICY,
} from './custom-order-schedule.policy';
import { resolveDelayEligibility } from './custom-order-dispute.policy';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-03T09:00:00.000Z');

/** A live, paid order with the brand's published lead times snapshotted on it. */
function baseOrder(overrides: Partial<Parameters<typeof resolveOrderSchedule>[0]> = {}) {
  return {
    status: CustomOrderStatus.IN_PRODUCTION,
    acceptedAt: new Date('2026-09-12T09:00:00.000Z'),
    createdAt: new Date('2026-09-12T09:00:00.000Z'),
    productionLeadDaysSnapshot: 10,
    deliveryMaxDaysSnapshot: 4,
    now: NOW,
    ...overrides,
  };
}

describe('resolveOrderSchedule', () => {
  it('prefers a recorded promise over the brand lead times', () => {
    const promised = new Date('2026-10-20T09:00:00.000Z');
    const schedule = resolveOrderSchedule(
      baseOrder({ promisedProductionAt: promised }),
    );

    expect(schedule.expectedProductionAt).toEqual(promised);
    expect(schedule.state).toBe('ON_TRACK');
    // The countdown runs against the recorded production promise, so it is not
    // an estimate — even though the delivery date beside it was derived.
    expect(schedule.estimated).toBe(false);
    expect(schedule.productionEstimated).toBe(false);
    expect(schedule.deliveryEstimated).toBe(true);
  });

  it('reports the provenance of the date the countdown actually uses', () => {
    // Production recorded, delivery derived, and production is finished — so
    // the countdown is now running against a DERIVED delivery date and must
    // say so.
    const schedule = resolveOrderSchedule(
      baseOrder({
        status: CustomOrderStatus.IN_TRANSIT,
        promisedProductionAt: new Date('2026-09-20T09:00:00.000Z'),
      }),
    );

    expect(schedule.deliveryEstimated).toBe(true);
    expect(schedule.estimated).toBe(true);
  });

  /**
   * The bug this policy exists for. An order accepted on 12 September with a
   * 10-day production lead was due on the 22nd; on 3 October it is 11 days
   * late, and before this resolver existed it reported no deadline at all.
   */
  it('derives dates from the lead-time snapshots when no promise was recorded', () => {
    const schedule = resolveOrderSchedule(baseOrder());

    expect(schedule.estimated).toBe(true);
    expect(schedule.expectedProductionAt).toEqual(
      new Date('2026-09-22T09:00:00.000Z'),
    );
    // Delivery runs from the END of production, not from the order date.
    expect(schedule.expectedDeliveryAt).toEqual(
      new Date('2026-09-26T09:00:00.000Z'),
    );
    expect(schedule.state).toBe('OVERDUE');
    expect(schedule.daysOverdue).toBe(11);
  });

  it('folds approved extension days into a derived date', () => {
    const schedule = resolveOrderSchedule(
      baseOrder({ totalExtensionDaysGranted: 6 }),
    );

    expect(schedule.expectedProductionAt).toEqual(
      new Date('2026-09-28T09:00:00.000Z'),
    );
    expect(schedule.extensionDaysGranted).toBe(6);
  });

  it('does not fold extension days into a RECORDED promise, which already has them', () => {
    const promised = new Date('2026-10-10T09:00:00.000Z');
    const schedule = resolveOrderSchedule(
      baseOrder({ promisedProductionAt: promised, totalExtensionDaysGranted: 6 }),
    );

    expect(schedule.expectedProductionAt).toEqual(promised);
  });

  it('flags an order inside the due-soon window', () => {
    const schedule = resolveOrderSchedule(
      baseOrder({
        promisedProductionAt: new Date(
          NOW.getTime() + SCHEDULE_POLICY.dueSoonDays * DAY - 60_000,
        ),
      }),
    );

    expect(schedule.state).toBe('DUE_SOON');
  });

  it('measures against DELIVERY once production is finished', () => {
    const schedule = resolveOrderSchedule(
      baseOrder({
        status: CustomOrderStatus.IN_TRANSIT,
        promisedProductionAt: new Date('2026-09-20T09:00:00.000Z'),
        promisedDeliveryAt: new Date('2026-10-10T09:00:00.000Z'),
      }),
    );

    // Production is behind us, so a missed production date is no longer the
    // question and the order is not late.
    expect(schedule.state).toBe('ON_TRACK');
    expect(schedule.daysOverdue).toBe(0);
  });

  it('stops counting once the order is settled or not yet started', () => {
    expect(
      resolveOrderSchedule(baseOrder({ status: CustomOrderStatus.COMPLETED })).state,
    ).toBe('CLOSED');
    expect(
      resolveOrderSchedule(baseOrder({ status: CustomOrderStatus.PENDING_PAYMENT }))
        .state,
    ).toBe('NOT_STARTED');
    expect(
      resolveOrderSchedule(
        baseOrder({ status: CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION }),
      ).state,
    ).toBe('DELIVERED');
  });

  it('survives an order carrying neither a promise nor lead times', () => {
    const schedule = resolveOrderSchedule(
      baseOrder({
        productionLeadDaysSnapshot: null,
        deliveryMaxDaysSnapshot: null,
      }),
    );

    expect(schedule.expectedProductionAt).toBeNull();
    expect(schedule.state).toBe('ON_TRACK');
    expect(schedule.daysRemaining).toBeNull();
  });

  it('rounds a part-day towards the future rather than reporting zero', () => {
    const schedule = resolveOrderSchedule(
      baseOrder({ promisedProductionAt: new Date(NOW.getTime() + 18 * 60 * 60 * 1000) }),
    );

    expect(schedule.daysRemaining).toBe(1);
  });
});

/**
 * The two policies have to agree, because the screen shows one and the button
 * is gated on the other. Showing "11 days late" above a screen with no way to
 * report it is the state this pairing exists to prevent.
 */
describe('schedule feeding the delay-dispute gate', () => {
  it('makes a lead-time-derived overdue order disputable', () => {
    const schedule = resolveOrderSchedule(baseOrder());
    const eligibility = resolveDelayEligibility({
      status: CustomOrderStatus.IN_PRODUCTION,
      promisedProductionAt: schedule.expectedProductionAt,
      promisedDeliveryAt: schedule.expectedDeliveryAt,
      hasOpenDispute: false,
      now: NOW,
    });

    expect(eligibility.eligible).toBe(true);
  });

  it('still answers NO_PROMISE_RECORDED when the raw dates are used', () => {
    // Guards the regression: this is what the endpoint returned before the
    // schedule was wired in, and it is why the control never appeared.
    const eligibility = resolveDelayEligibility({
      status: CustomOrderStatus.IN_PRODUCTION,
      promisedProductionAt: null,
      promisedDeliveryAt: null,
      hasOpenDispute: false,
      now: NOW,
    });

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe('NO_PROMISE_RECORDED');
  });

  it('does not offer a second dispute while one is open', () => {
    const schedule = resolveOrderSchedule(baseOrder());
    const eligibility = resolveDelayEligibility({
      status: CustomOrderStatus.IN_PRODUCTION,
      promisedProductionAt: schedule.expectedProductionAt,
      promisedDeliveryAt: schedule.expectedDeliveryAt,
      hasOpenDispute: true,
      now: NOW,
    });

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe('ALREADY_DISPUTED');
  });
});
