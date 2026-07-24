/**
 * One-off repair for paid custom orders whose buyerPriceSummaryJson.grandTotal
 * is missing or non-positive, which blocks settlement/finance posting.
 *
 * Recovery order:
 *  1) Recompute from summary components (subtotal/outfit + shipping/delivery + rush)
 *  2) Fall back to linked PaymentAttempt amount / settlementAmount
 *  3) Fall back to baseProduction + fabric yards*cost + rush (no shipping)
 *
 * Usage (from bthreadly/):
 *   npx ts-node -r tsconfig-paths/register scripts/repair-custom-order-grand-total.ts
 *   npx ts-node -r tsconfig-paths/register scripts/repair-custom-order-grand-total.ts --write
 *   npx ts-node -r tsconfig-paths/register scripts/repair-custom-order-grand-total.ts --write --limit=100
 *   npx ts-node -r tsconfig-paths/register scripts/repair-custom-order-grand-total.ts --write --settle
 */
import { PaymentStatus, Prisma } from '@prisma/client';
import { createScriptPrismaClient } from './helpers/create-script-prisma';

type Args = {
  write: boolean;
  settle: boolean;
  limit: number;
  json: boolean;
};

type RepairRow = {
  customOrderId: string;
  brandId: string;
  paymentStatus: string;
  previousGrandTotal: number;
  repairedGrandTotal: number | null;
  source: string | null;
  safe: boolean;
  reason: string;
  settled?: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { write: false, settle: false, limit: 200, json: false };
  for (const arg of argv) {
    if (arg === '--write') {
      args.write = true;
      continue;
    }
    if (arg === '--settle') {
      args.settle = true;
      continue;
    }
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const value = Number(arg.split('=')[1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--limit must be a positive number');
      }
      args.limit = Math.min(1000, Math.floor(value));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function money(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function extractGrandTotal(summary: Record<string, unknown>): number {
  return money(summary.grandTotal);
}

function recomputeFromComponents(summary: Record<string, unknown>): number | null {
  const subtotal = money(summary.subtotal ?? summary.outfitTotal);
  const shipping = money(summary.shippingFee ?? summary.delivery);
  const rush = money(summary.rushFee ?? summary.rush);
  const total = money(subtotal + shipping + rush);
  return total > 0 ? total : null;
}

function recomputeFromSnapshots(order: {
  baseProductionChargeSnapshot: Prisma.Decimal | number;
  fabricCostPerYardSnapshot: Prisma.Decimal | number;
  computedYards: Prisma.Decimal | number;
  rushFeeSnapshot: Prisma.Decimal | number | null;
  rushSelected: boolean;
}): number | null {
  const base = money(order.baseProductionChargeSnapshot);
  const yards = money(order.computedYards);
  const perYard = money(order.fabricCostPerYardSnapshot);
  const fabric = money(yards * perYard);
  const rush = order.rushSelected ? money(order.rushFeeSnapshot) : 0;
  const total = money(base + fabric + rush);
  return total > 0 ? total : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { prisma, disconnect } = createScriptPrismaClient();

  try {
    const candidates = await prisma.customOrder.findMany({
      where: {
        paymentStatus: PaymentStatus.PAID,
      },
      orderBy: { createdAt: 'asc' },
      take: args.limit,
      select: {
        id: true,
        brandId: true,
        paymentStatus: true,
        paymentReference: true,
        currency: true,
        buyerPriceSummaryJson: true,
        baseProductionChargeSnapshot: true,
        fabricCostPerYardSnapshot: true,
        computedYards: true,
        rushFeeSnapshot: true,
        rushSelected: true,
        acceptedAt: true,
        createdAt: true,
      },
    });

    const bad = candidates.filter((order) => {
      const summary = asRecord(order.buyerPriceSummaryJson);
      return extractGrandTotal(summary) <= 0;
    });

    const paymentRefs = Array.from(
      new Set(
        bad
          .map((order) => order.paymentReference)
          .filter((ref): ref is string => Boolean(ref)),
      ),
    );

    const attempts = paymentRefs.length
      ? await prisma.paymentAttempt.findMany({
          where: {
            OR: [
              { reference: { in: paymentRefs } },
              { customOrderId: { in: bad.map((order) => order.id) } },
            ],
            status: 'PAID',
          },
          select: {
            reference: true,
            customOrderId: true,
            amount: true,
            settlementAmount: true,
          },
        })
      : [];

    const attemptByRef = new Map(
      attempts
        .filter((attempt) => attempt.reference)
        .map((attempt) => [String(attempt.reference), attempt]),
    );
    const attemptByOrderId = new Map(
      attempts
        .filter((attempt) => attempt.customOrderId)
        .map((attempt) => [String(attempt.customOrderId), attempt]),
    );

    const rows: RepairRow[] = [];

    for (const order of bad) {
      const summary = asRecord(order.buyerPriceSummaryJson);
      const previous = extractGrandTotal(summary);
      let repaired: number | null = null;
      let source: string | null = null;

      repaired = recomputeFromComponents(summary);
      if (repaired != null) {
        source = 'summary_components';
      }

      if (repaired == null) {
        const attempt =
          (order.paymentReference
            ? attemptByRef.get(order.paymentReference)
            : null) ?? attemptByOrderId.get(order.id) ?? null;
        const fromAttempt = money(
          attempt?.settlementAmount ?? attempt?.amount ?? 0,
        );
        if (fromAttempt > 0) {
          repaired = fromAttempt;
          source = 'payment_attempt';
        }
      }

      if (repaired == null) {
        repaired = recomputeFromSnapshots(order);
        if (repaired != null) {
          source = 'production_snapshots_no_shipping';
        }
      }

      if (repaired == null || repaired <= 0) {
        rows.push({
          customOrderId: order.id,
          brandId: order.brandId,
          paymentStatus: order.paymentStatus,
          previousGrandTotal: previous,
          repairedGrandTotal: null,
          source: null,
          safe: false,
          reason: 'Unable to derive a positive grandTotal from summary, payment, or snapshots',
        });
        continue;
      }

      rows.push({
        customOrderId: order.id,
        brandId: order.brandId,
        paymentStatus: order.paymentStatus,
        previousGrandTotal: previous,
        repairedGrandTotal: repaired,
        source,
        safe: true,
        reason:
          source === 'production_snapshots_no_shipping'
            ? 'Derived without shipping — review if delivery fee should be added'
            : 'Ready to write',
      });

      if (!args.write) {
        continue;
      }

      const nextSummary = {
        ...summary,
        grandTotal: repaired,
        currency: summary.currency ?? order.currency ?? 'NGN',
      };

      await prisma.customOrder.update({
        where: { id: order.id },
        data: {
          buyerPriceSummaryJson: nextSummary as Prisma.InputJsonValue,
        },
      });
    }

    let settledCount = 0;
    if (args.write && args.settle) {
      // Lazy-require Nest bootstrap only when settling to keep dry-run light.
      // Prefer brand finance self-heal / admin repair endpoint in production ops;
      // this flag is for offline one-shot recovery after grandTotal writes.
      const { NestFactory } = await import('@nestjs/core');
      const { Module } = await import('@nestjs/common');
      const { ConfigModule } = await import('@nestjs/config');
      const { FinanceModule } = await import('../src/finance/finance.module');
      const { CustomOrderFinanceSyncService } = await import(
        '../src/finance/custom-order-finance-sync.service'
      );

      @Module({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
          FinanceModule,
        ],
      })
      class RepairCliModule {}

      const app = await NestFactory.createApplicationContext(RepairCliModule, {
        logger: ['error', 'warn'],
      });
      try {
        const sync = app.get(CustomOrderFinanceSyncService);
        const orderIds = rows
          .filter((row) => row.safe && row.repairedGrandTotal != null)
          .map((row) => row.customOrderId);
        settledCount =
          await sync.ensureSettlementForCustomOrderIds(orderIds);
        for (const row of rows) {
          if (row.safe && row.repairedGrandTotal != null) {
            row.settled = true;
          }
        }
      } finally {
        await app.close();
      }
    }

    const summary = {
      mode: args.write ? 'write' : 'dry-run',
      settle: args.settle,
      scannedPaid: candidates.length,
      missingOrZeroGrandTotal: bad.length,
      repairable: rows.filter((row) => row.safe).length,
      unrepairable: rows.filter((row) => !row.safe).length,
      written: args.write ? rows.filter((row) => row.safe).length : 0,
      settled: settledCount,
    };

    if (args.json) {
      console.log(JSON.stringify({ summary, rows }, null, 2));
    } else {
      console.log('Custom-order grandTotal repair');
      console.table(summary);
      console.log('');
      console.table(
        rows.map((row) => ({
          customOrderId: row.customOrderId.slice(0, 8),
          brandId: row.brandId.slice(0, 8),
          previous: row.previousGrandTotal,
          repaired: row.repairedGrandTotal,
          source: row.source,
          safe: row.safe,
          reason: row.reason,
        })),
      );
      if (!args.write) {
        console.log('\nDry-run only. Re-run with --write to persist grandTotal fixes.');
      }
      if (args.write && !args.settle) {
        console.log(
          '\nTotals written. Run admin "Repair custom settlements" or re-open brand finance for settlement self-heal, or re-run with --settle.',
        );
      }
    }
  } finally {
    await disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
