import { PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

export type StandardOrderPaymentSnapshot = {
  id: string;
  paymentReference: string | null;
  paymentStatus: PaymentStatus;
  paidAt?: Date | null;
};

type PaymentAttemptSnapshot = {
  reference: string;
  status: string | null;
  confirmedAt: Date | null;
  providerMode?: string | null;
  responseSnapshot?: unknown;
};

export const mapAttemptStatusToPaymentStatus = (
  status: string | null | undefined,
): PaymentStatus => {
  switch ((status ?? '').toUpperCase()) {
    case 'PAID':
      return PaymentStatus.PAID;
    case 'FAILED':
    case 'CANCELLED':
    case 'EXPIRED':
      return PaymentStatus.FAILED;
    default:
      return PaymentStatus.PENDING;
  }
};

const TERMINAL_ATTEMPT_STATUSES = new Set([
  'PAID',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
]);

/** Only an unpaid order may be brought up to date from its capture on read. */
const REPAIRABLE_ORDER_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.PENDING,
  PaymentStatus.FAILED,
]);

/**
 * Capture statuses that describe the payment itself. Refund-stage statuses
 * (REFUND_IN_PROGRESS, PARTIALLY_REFUNDED, REFUNDED) say nothing about any one
 * order on the capture and never change an order here.
 */
const REPAIRABLE_ATTEMPT_STATUSES = new Set([
  'PENDING',
  'PROCESSING',
  'PAID',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
]);

const normalizeMockStatusHint = (value: unknown): string | null => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  switch (normalized) {
    case 'success':
    case 'paid':
      return 'PAID';
    case 'failed':
    case 'fail':
      return 'FAILED';
    case 'cancel':
    case 'cancelled':
      return 'CANCELLED';
    case 'expired':
    case 'expire':
      return 'EXPIRED';
    case 'processing':
    case 'pending':
      return 'PROCESSING';
    default:
      return null;
  }
};

const extractMockReturnStatus = (snapshot: unknown): string | null => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null;
  }

  return normalizeMockStatusHint(
    (snapshot as Record<string, unknown>).mockReturnStatus,
  );
};

const resolveEffectiveAttemptStatus = (
  attempt: PaymentAttemptSnapshot,
): string => {
  const storedStatus =
    String(attempt.status ?? '')
      .trim()
      .toUpperCase() || 'PENDING';
  if (TERMINAL_ATTEMPT_STATUSES.has(storedStatus)) {
    return storedStatus;
  }

  if (
    String(attempt.providerMode ?? '')
      .trim()
      .toLowerCase() === 'mock'
  ) {
    return extractMockReturnStatus(attempt.responseSnapshot) ?? storedStatus;
  }

  return storedStatus;
};

export const reconcileStandardOrderPaymentStatuses = async (
  prisma: PrismaService,
  orders: StandardOrderPaymentSnapshot[],
): Promise<Map<string, PaymentStatus>> => {
  const references = Array.from(
    new Set(
      orders
        .map((order) => order.paymentReference)
        .filter((reference): reference is string => Boolean(reference)),
    ),
  );

  const resolvedByOrderId = new Map<string, PaymentStatus>();
  if (references.length === 0) {
    return resolvedByOrderId;
  }

  const attempts = await prisma.paymentAttempt.findMany({
    where: { reference: { in: references } },
    select: {
      reference: true,
      status: true,
      confirmedAt: true,
      providerMode: true,
      responseSnapshot: true,
    },
  });

  const attemptByReference = new Map(
    attempts.map((attempt) => [attempt.reference, attempt]),
  );

  const paymentAttemptUpdates = new Map<
    string,
    Prisma.PrismaPromise<unknown>
  >();
  const orderUpdates = orders
    .map((order) => {
      const reference = order.paymentReference;
      if (!reference) return null;
      const attempt = attemptByReference.get(reference);
      if (!attempt) return null;

      // A read never moves a paid or refunded order: refunds are decided by
      // the refund engine, and one capture can fund several orders.
      if (!REPAIRABLE_ORDER_STATUSES.has(order.paymentStatus)) {
        resolvedByOrderId.set(order.id, order.paymentStatus);
        return null;
      }
      const effectiveAttemptStatus = resolveEffectiveAttemptStatus(attempt);
      if (!REPAIRABLE_ATTEMPT_STATUSES.has(effectiveAttemptStatus)) {
        resolvedByOrderId.set(order.id, order.paymentStatus);
        return null;
      }
      const resolvedStatus = mapAttemptStatusToPaymentStatus(
        effectiveAttemptStatus,
      );
      resolvedByOrderId.set(order.id, resolvedStatus);

      if (
        order.paymentStatus === resolvedStatus &&
        (resolvedStatus !== PaymentStatus.PAID ||
          order.paidAt ||
          attempt.confirmedAt)
      ) {
        if (effectiveAttemptStatus === attempt.status) {
          return null;
        }
      }

      const settledAt =
        resolvedStatus === PaymentStatus.PAID
          ? (attempt.confirmedAt ?? new Date())
          : null;

      if (
        effectiveAttemptStatus !== attempt.status &&
        !paymentAttemptUpdates.has(reference)
      ) {
        paymentAttemptUpdates.set(
          reference,
          prisma.paymentAttempt.update({
            where: { reference },
            data: {
              status: effectiveAttemptStatus as any,
              confirmedAt:
                effectiveAttemptStatus === 'PAID'
                  ? settledAt
                  : attempt.confirmedAt,
              lastVerifiedAt: new Date(),
            },
          }),
        );
      }

      // Conditional on the status this read observed: a concurrent writer wins.
      return prisma.order.updateMany({
        where: { id: order.id, paymentStatus: order.paymentStatus },
        data: {
          paymentStatus: resolvedStatus,
          paidAt: settledAt,
        },
      });
    })
    .filter(Boolean);

  const updates = [
    ...paymentAttemptUpdates.values(),
    ...(orderUpdates as Prisma.PrismaPromise<unknown>[]),
  ];

  if (updates.length > 0) {
    await prisma.$transaction(updates);
  }

  return resolvedByOrderId;
};
