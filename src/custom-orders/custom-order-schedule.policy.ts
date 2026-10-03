/**
 * When a bespoke order is actually due, and how late it is.
 *
 * Two problems this exists to fix, and they turned out to be the same problem.
 *
 * The first is a dead control. `resolveDelayEligibility` needs a promise date
 * to decide whether a shopper may escalate; with none it answers
 * `NO_PROMISE_RECORDED` and the report button never appears. `promised*` is
 * written once, at payment confirmation — so every order accepted by another
 * path, and every order that predates that code, has nulls there and can never
 * be disputed no matter how late it gets. An order placed on 12 September and
 * still in production on 3 October offered its shopper nothing at all.
 *
 * The second is that the orders list showed a placement date and no sense of
 * time: a shopper had to open each order to find out any of them were late.
 *
 * Both want the same missing thing — a date the order is *expected* by — and
 * the data for it has been on every row since the beginning. `CustomOrder`
 * snapshots the brand's store-setup lead times at order time:
 * `productionLeadDaysSnapshot`, `deliveryMinDaysSnapshot`,
 * `deliveryMaxDaysSnapshot`, all non-null. So when a recorded promise is
 * missing, derive it from the commitment the brand actually published, rather
 * than treating the order as having no deadline.
 *
 * A derived date is marked `estimated` and the clients say so. It is a floor,
 * not a guess: the brand committed to those lead times publicly, so it is the
 * least generous honest reading of what they promised.
 *
 * One module because the list, the detail payload and the dispute gate must
 * agree. They disagreed before, which is how a screen came to show "Overdue"
 * beside no way to act on it.
 */
import { CustomOrderStatus } from '@prisma/client';

export const SCHEDULE_POLICY = {
  /** Inside this many days of the promise, a row starts flagging itself. */
  dueSoonDays: 2,
} as const;

export type OrderScheduleState =
  /** Not paid/accepted yet — no clock has started. */
  | 'NOT_STARTED'
  | 'ON_TRACK'
  | 'DUE_SOON'
  | 'OVERDUE'
  /** Reached the shopper; the production clock is no longer the question. */
  | 'DELIVERED'
  /** Finished, cancelled or refunded — nothing left to count. */
  | 'CLOSED';

export interface OrderSchedule {
  expectedProductionAt: Date | null;
  expectedDeliveryAt: Date | null;
  /**
   * Whether the date the countdown is MEASURED AGAINST was derived.
   *
   * Deliberately about the governing date rather than about the pair. An order
   * routinely has a recorded production promise and no recorded delivery one;
   * flagging that whole schedule as an estimate would put "est." on a row whose
   * countdown is running against a date the brand actually committed to. The
   * clients show this next to the countdown, so it has to describe the same
   * date the countdown does.
   */
  estimated: boolean;
  /** Per-date provenance, for a caller that needs more than the headline. */
  productionEstimated: boolean;
  deliveryEstimated: boolean;
  state: OrderScheduleState;
  /** Whole days until delivery is due. Negative once it has passed. */
  daysRemaining: number | null;
  /** Whole days past due. Zero unless `state` is `OVERDUE`. */
  daysOverdue: number;
  /** Approved extension days already folded into the dates above. */
  extensionDaysGranted: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The clock has not started: nothing is owed until the order is live. */
const PRE_ACCEPTANCE_STATUSES: ReadonlySet<CustomOrderStatus> = new Set([
  CustomOrderStatus.DRAFT,
  CustomOrderStatus.PENDING_PAYMENT,
  CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
]);

/** Settled one way or another. A countdown here would be noise. */
const TERMINAL_STATUSES: ReadonlySet<CustomOrderStatus> = new Set([
  CustomOrderStatus.COMPLETED,
  CustomOrderStatus.CLOSED,
  CustomOrderStatus.REJECTED_BY_BRAND,
  CustomOrderStatus.CANCELLED_BY_BUYER_PRE_ACCEPTANCE,
  CustomOrderStatus.REFUND_IN_PROGRESS,
]);

/** In the shopper's hands. Lateness stops accruing. */
const DELIVERED_STATUSES: ReadonlySet<CustomOrderStatus> = new Set([
  CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
]);

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/**
 * Whole days between two instants, rounded towards the future.
 *
 * `Math.ceil` is deliberate: with eighteen hours left a shopper is told "1 day",
 * not "0 days". Rounding down reads as already-due to someone who still has
 * most of a day, which is the kind of small lie that produces support tickets.
 */
function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
}

export interface ResolveOrderScheduleParams {
  status: CustomOrderStatus;
  /** Recorded promises. Preferred over anything derived. */
  promisedProductionAt?: Date | null;
  promisedDeliveryAt?: Date | null;
  /** When the clock started. Falls back through to order creation. */
  acceptedAt?: Date | null;
  measurementConfirmedAt?: Date | null;
  createdAt: Date;
  /** The brand's published lead times, snapshotted at order time. */
  productionLeadDaysSnapshot?: number | null;
  deliveryMaxDaysSnapshot?: number | null;
  /** Already folded into `promised*`; added on top of derived dates. */
  totalExtensionDaysGranted?: number | null;
  deliveredAt?: Date | null;
  now?: Date;
}

export function resolveOrderSchedule(
  params: ResolveOrderScheduleParams,
): OrderSchedule {
  const now = params.now ?? new Date();
  const extensionDaysGranted = Math.max(
    0,
    params.totalExtensionDaysGranted ?? 0,
  );

  const empty = (state: OrderScheduleState): OrderSchedule => ({
    expectedProductionAt: null,
    expectedDeliveryAt: null,
    estimated: false,
    productionEstimated: false,
    deliveryEstimated: false,
    state,
    daysRemaining: null,
    daysOverdue: 0,
    extensionDaysGranted,
  });

  if (TERMINAL_STATUSES.has(params.status)) return empty('CLOSED');
  if (PRE_ACCEPTANCE_STATUSES.has(params.status)) return empty('NOT_STARTED');

  // The clock starts when the order became real. `acceptedAt` is the honest
  // anchor; the other two only matter for rows written before it was recorded.
  const startedAt =
    params.acceptedAt ?? params.measurementConfirmedAt ?? params.createdAt;

  const productionLeadDays = params.productionLeadDaysSnapshot ?? null;
  const deliveryMaxDays = params.deliveryMaxDaysSnapshot ?? null;

  // A recorded promise always wins — it is what the brand was actually told to
  // hit, extensions included. Derived dates are the fallback, and only then.
  let expectedProductionAt = params.promisedProductionAt ?? null;
  let expectedDeliveryAt = params.promisedDeliveryAt ?? null;
  let productionEstimated = false;
  let deliveryEstimated = false;

  if (!expectedProductionAt && productionLeadDays != null) {
    expectedProductionAt = addDays(
      startedAt,
      productionLeadDays + extensionDaysGranted,
    );
    productionEstimated = true;
  }

  if (!expectedDeliveryAt && deliveryMaxDays != null) {
    // Delivery runs from the end of production, not from the order date.
    const productionBase =
      expectedProductionAt ??
      (productionLeadDays != null
        ? addDays(startedAt, productionLeadDays + extensionDaysGranted)
        : null);
    if (productionBase) {
      expectedDeliveryAt = addDays(productionBase, deliveryMaxDays);
      deliveryEstimated = true;
    }
  }

  if (DELIVERED_STATUSES.has(params.status) || params.deliveredAt) {
    return {
      expectedProductionAt,
      expectedDeliveryAt,
      estimated: deliveryEstimated,
      productionEstimated,
      deliveryEstimated,
      state: 'DELIVERED',
      daysRemaining: null,
      daysOverdue: 0,
      extensionDaysGranted,
    };
  }

  // Which promise the shopper is waiting on right now. Before the garment is
  // finished that is production; after, it is delivery. Measuring against
  // delivery while a maker is three days late on cutting hides the delay.
  const productionDone =
    params.status === CustomOrderStatus.READY_FOR_DISPATCH ||
    params.status === CustomOrderStatus.IN_TRANSIT;
  const useDelivery = productionDone && expectedDeliveryAt != null;
  const governing = useDelivery
    ? expectedDeliveryAt
    : (expectedProductionAt ?? expectedDeliveryAt);
  // Whichever date won above is the one the countdown describes, so it is the
  // one `estimated` has to be about.
  const governingEstimated = useDelivery
    ? deliveryEstimated
    : expectedProductionAt != null
      ? productionEstimated
      : deliveryEstimated;

  if (!governing) {
    return {
      expectedProductionAt,
      expectedDeliveryAt,
      estimated: false,
      productionEstimated,
      deliveryEstimated,
      state: 'ON_TRACK',
      daysRemaining: null,
      daysOverdue: 0,
      extensionDaysGranted,
    };
  }

  const daysRemaining = daysBetween(now, governing);

  if (now.getTime() > governing.getTime()) {
    return {
      expectedProductionAt,
      expectedDeliveryAt,
      estimated: governingEstimated,
      productionEstimated,
      deliveryEstimated,
      state: 'OVERDUE',
      daysRemaining,
      daysOverdue: Math.max(1, Math.abs(daysRemaining)),
      extensionDaysGranted,
    };
  }

  return {
    expectedProductionAt,
    expectedDeliveryAt,
    estimated: governingEstimated,
    productionEstimated,
    deliveryEstimated,
    state: daysRemaining <= SCHEDULE_POLICY.dueSoonDays ? 'DUE_SOON' : 'ON_TRACK',
    daysRemaining,
    daysOverdue: 0,
    extensionDaysGranted,
  };
}

/** The shape the clients receive. Dates as ISO strings, everything else as-is. */
export function serializeOrderSchedule(schedule: OrderSchedule) {
  return {
    expectedProductionAt: schedule.expectedProductionAt?.toISOString() ?? null,
    expectedDeliveryAt: schedule.expectedDeliveryAt?.toISOString() ?? null,
    estimated: schedule.estimated,
    productionEstimated: schedule.productionEstimated,
    deliveryEstimated: schedule.deliveryEstimated,
    state: schedule.state,
    daysRemaining: schedule.daysRemaining,
    daysOverdue: schedule.daysOverdue,
    extensionDaysGranted: schedule.extensionDaysGranted,
  };
}
