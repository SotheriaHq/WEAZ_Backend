type BuyerLike = {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  userProfile?: {
    firstName?: string | null;
    lastName?: string | null;
  } | null;
} | null;

type StandardOrderSourceAllocation = {
  id: string;
  amount?: unknown;
  currency?: string | null;
  createdAt?: Date | string | null;
  releaseStage?: string | null;
  ledgerEntry?: {
    id: string;
    amount?: unknown;
    createdAt?: Date | string | null;
    transaction?: {
      referenceId?: string | null;
      referenceType?: string | null;
      description?: string | null;
      totalAmount?: unknown;
      currency?: string | null;
      createdAt?: Date | string | null;
    } | null;
  } | null;
  escrowHold?: {
    id: string;
    order?: {
      id: string;
      customerName?: string | null;
      orderItems?: Array<{
        nameAtPurchase?: string | null;
      }>;
    } | null;
  } | null;
};

type CustomOrderSourceAllocation = {
  id: string;
  allocationType?: string | null;
  amount?: unknown;
  commissionAmount?: unknown;
  netBrandAmount?: unknown;
  currency?: string | null;
  eligibleAt?: Date | string | null;
  createdAt?: Date | string | null;
  customOrderId?: string | null;
  customOrder?: {
    id: string;
    title?: string | null;
    sourceTitleSnapshot?: string | null;
    buyer?: BuyerLike;
  } | null;
};

type PayoutSourceBreakdownInput = {
  amount?: unknown;
  currency?: string | null;
  ledgerSourceAllocations?: StandardOrderSourceAllocation[] | null;
  ledgerAllocations?: CustomOrderSourceAllocation[] | null;
};

const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const toMoney = (value: unknown) => {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return roundMoney(numeric);
};

const shortCode = (value?: string | null) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return null;
  }
  return `#${normalized.slice(0, 8).toUpperCase()}`;
};

const buildBuyerName = (buyer?: BuyerLike) => {
  const fullName = [buyer?.userProfile?.firstName, buyer?.userProfile?.lastName]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  if (fullName) {
    return fullName;
  }
  const username = String(buyer?.username || '').trim();
  return username || null;
};

const describeStandardStage = (
  releaseStage?: string | null,
  description?: string | null,
) => {
  const normalized = String(releaseStage || '')
    .trim()
    .toUpperCase();
  if (normalized === 'SHIPMENT_PORTION') {
    return 'Shipment release';
  }
  if (normalized === 'FINAL_PORTION') {
    return 'Final release';
  }

  const descriptionText = String(description || '')
    .trim()
    .toLowerCase();
  if (descriptionText.includes('shipment')) {
    return 'Shipment release';
  }
  if (descriptionText.includes('final')) {
    return 'Final release';
  }
  return 'Release';
};

const describeCustomStage = (allocationType?: string | null) => {
  const normalized = String(allocationType || '')
    .trim()
    .toUpperCase();
  if (normalized === 'BRAND_ACCEPTANCE_PORTION') {
    return 'Accepted release';
  }
  if (normalized === 'FINAL_DELIVERY_PORTION') {
    return 'Delivered release';
  }
  return normalized ? normalized.replaceAll('_', ' ') : 'Custom release';
};

export const buildPayoutSourceBreakdown = (
  input?: PayoutSourceBreakdownInput | null,
) => {
  const payoutCurrency = String(input?.currency || 'NGN').trim() || 'NGN';

  const standardItems = (input?.ledgerSourceAllocations || []).map((row) => {
    const transaction = row.ledgerEntry?.transaction;
    const order = row.escrowHold?.order;
    const creditedAmount = toMoney(row.ledgerEntry?.amount);
    const reservedAmount = toMoney(row.amount);
    const grossAmount =
      transaction?.totalAmount != null
        ? toMoney(transaction.totalAmount)
        : null;
    const commissionAmount =
      grossAmount != null && grossAmount >= creditedAmount
        ? roundMoney(grossAmount - creditedAmount)
        : null;
    const label =
      String(order?.orderItems?.[0]?.nameAtPurchase || '').trim() ||
      `Order ${shortCode(transaction?.referenceId || order?.id) || ''}`.trim();

    return {
      id: row.id,
      sourceType: 'STANDARD_ORDER' as const,
      label,
      counterparty: order?.customerName?.trim() || null,
      referenceId: transaction?.referenceId ?? order?.id ?? null,
      referenceCode: shortCode(transaction?.referenceId || order?.id),
      releaseStage: describeStandardStage(
        row.releaseStage,
        transaction?.description,
      ),
      reservedAmount,
      creditedAmount,
      grossAmount,
      commissionAmount,
      currency:
        String(
          row.currency || transaction?.currency || payoutCurrency,
        ).trim() || payoutCurrency,
      sourceCreatedAt:
        transaction?.createdAt ?? row.ledgerEntry?.createdAt ?? null,
      linkedAt: row.createdAt ?? null,
      note:
        creditedAmount > reservedAmount
          ? 'Reserved as part of a larger released balance credit.'
          : null,
    };
  });

  const customItems = (input?.ledgerAllocations || []).map((row) => {
    const orderId = row.customOrder?.id ?? row.customOrderId ?? null;
    const grossAmount = toMoney(row.amount);
    const commissionAmount =
      row.commissionAmount != null ? toMoney(row.commissionAmount) : null;
    const creditedAmount = toMoney(row.netBrandAmount);
    return {
      id: row.id,
      sourceType: 'CUSTOM_ORDER' as const,
      label:
        String(
          row.customOrder?.title || row.customOrder?.sourceTitleSnapshot || '',
        ).trim() || `Custom order ${shortCode(orderId) || ''}`.trim(),
      counterparty: buildBuyerName(row.customOrder?.buyer),
      referenceId: orderId,
      referenceCode: shortCode(orderId),
      releaseStage: describeCustomStage(row.allocationType),
      reservedAmount: creditedAmount,
      creditedAmount,
      grossAmount,
      commissionAmount,
      currency: String(row.currency || payoutCurrency).trim() || payoutCurrency,
      sourceCreatedAt: row.eligibleAt ?? row.createdAt ?? null,
      linkedAt: row.createdAt ?? null,
      note: null,
    };
  });

  const items = [...standardItems, ...customItems].sort((left, right) => {
    const leftTime = new Date(
      String(left.sourceCreatedAt || left.linkedAt || 0),
    ).getTime();
    const rightTime = new Date(
      String(right.sourceCreatedAt || right.linkedAt || 0),
    ).getTime();
    return rightTime - leftTime;
  });

  const payoutAmount = toMoney(input?.amount);
  const attributedAmount = roundMoney(
    items.reduce((sum, item) => sum + item.reservedAmount, 0),
  );

  return {
    payoutAmount,
    attributedAmount,
    unattributedAmount: Math.max(
      0,
      roundMoney(payoutAmount - attributedAmount),
    ),
    itemCount: items.length,
    standardOrderCount: standardItems.length,
    customOrderCount: customItems.length,
    items,
  };
};
