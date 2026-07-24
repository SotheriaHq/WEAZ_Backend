import { createScriptPrismaClient } from './helpers/create-script-prisma';

async function main() {
  const { prisma, disconnect } = createScriptPrismaClient();
  try {
    const orders = await prisma.customOrder.findMany({
      where: { paymentStatus: 'PAID' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        sourceTitleSnapshot: true,
        buyerPriceSummaryJson: true,
        baseProductionChargeSnapshot: true,
        fabricCostPerYardSnapshot: true,
        computedYards: true,
        rushFeeSnapshot: true,
        rushSelected: true,
        currency: true,
        paymentStatus: true,
        internalPriceBreakdownJson: true,
      },
    });

    for (const order of orders) {
      const summary = (order.buyerPriceSummaryJson || {}) as Record<string, unknown>;
      const internal = (order.internalPriceBreakdownJson || {}) as Record<string, unknown>;
      const fabric = Number(summary.fabricCharge ?? 0);
      const subtotal = Number(summary.subtotal ?? summary.outfitTotal ?? 0);
      const shipping = Number(summary.shippingFee ?? summary.delivery ?? 0);
      const rush = Number(summary.rushFee ?? summary.rush ?? 0);
      const grandTotal = Number(summary.grandTotal ?? 0);
      const productionBase = Math.max(0, subtotal - fabric - rush);
      const lineSum = productionBase + fabric + shipping + rush;

      console.log('---');
      console.log({
        id: order.id.slice(0, 8),
        title: order.sourceTitleSnapshot,
        rushSelected: order.rushSelected,
        snapshots: {
          baseProduction: String(order.baseProductionChargeSnapshot),
          fabricPerYard: String(order.fabricCostPerYardSnapshot),
          yards: String(order.computedYards),
          rushFeeSnapshot: order.rushFeeSnapshot
            ? String(order.rushFeeSnapshot)
            : null,
        },
        buyerPriceSummaryJson: summary,
        internalKeyMoney: {
          baseProductionCharge: internal.baseProductionCharge,
          fabricComponentTotal: internal.fabricComponentTotal,
          rushFee: internal.rushFee,
          deliveryFee: internal.deliveryFee,
          subtotalBeforeDelivery: internal.subtotalBeforeDelivery,
          grandTotal: internal.grandTotal,
        },
        derived: {
          productionBase,
          fabric,
          rush,
          shipping,
          lineSum,
          grandTotal,
          matches: Math.abs(lineSum - grandTotal) < 0.02,
        },
      });
    }

    console.log(`\nScanned ${orders.length} paid custom order(s).`);
  } finally {
    await disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
