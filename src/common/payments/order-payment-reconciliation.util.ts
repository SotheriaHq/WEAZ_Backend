import { PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

export type StandardOrderPaymentSnapshot = {
  id: string;
  paymentReference: string | null;
  paymentStatus: PaymentStatus;
  paidAt?: Date | null;
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
    select: { reference: true, status: true, confirmedAt: true },
  });

  const attemptByReference = new Map(
    attempts.map((attempt) => [attempt.reference, attempt]),
  );

  const updates = orders
    .map((order) => {
      const reference = order.paymentReference;
      if (!reference) return null;
      const attempt = attemptByReference.get(reference);
      if (!attempt) return null;

      const resolvedStatus = mapAttemptStatusToPaymentStatus(attempt.status);
      resolvedByOrderId.set(order.id, resolvedStatus);

      if (
        order.paymentStatus === resolvedStatus &&
        (resolvedStatus !== PaymentStatus.PAID || order.paidAt || !attempt.confirmedAt)
      ) {
        return null;
      }

      return prisma.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: resolvedStatus,
          paidAt: resolvedStatus === PaymentStatus.PAID ? attempt.confirmedAt : null,
        },
      });
    })
    .filter(Boolean);

  if (updates.length > 0) {
    await prisma.$transaction(updates as Prisma.PrismaPromise<unknown>[]);
  }

  return resolvedByOrderId;
};
