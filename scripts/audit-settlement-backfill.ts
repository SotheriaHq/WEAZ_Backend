import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FinanceModule } from '../src/finance/finance.module';
import {
  SettlementBackfillOptions,
  SettlementBackfillService,
} from '../src/finance/settlement-backfill.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    FinanceModule,
  ],
})
class SettlementBackfillCliModule {}

function parseArgs(
  argv: string[],
): SettlementBackfillOptions & { json: boolean } {
  const options: SettlementBackfillOptions & { json: boolean } = {
    orderType: 'all',
    write: false,
    json: false,
  };

  for (const arg of argv) {
    if (arg === '--write') {
      options.write = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg.startsWith('--order-type=')) {
      const value = arg.split('=')[1] as SettlementBackfillOptions['orderType'];
      if (!['standard', 'custom', 'all'].includes(String(value))) {
        throw new Error('--order-type must be standard, custom, or all');
      }
      options.orderType = value;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const value = Number(arg.split('=')[1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--limit must be a positive number');
      }
      options.limit = Math.floor(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHuman(
  report: Awaited<ReturnType<SettlementBackfillService['auditAndBackfill']>>,
) {
  console.log(`Settlement snapshot backfill ${report.mode}`);
  console.log(`Order type: ${report.options.orderType}`);
  console.log(`Limit: ${report.options.limit}`);
  console.log('');
  console.log('Standard orders');
  console.table(report.standard.summary);
  console.log('Custom orders');
  console.table(report.custom.summary);
  console.log('Duplicate custom-order allocations');
  console.log(`Groups: ${report.duplicateAllocations.groups.length}`);
  console.log(report.duplicateAllocations.recommendation);

  const unsafeStandard = report.standard.records.filter(
    (record) => !record.backfillSafe,
  );
  const unsafeCustom = report.custom.records.filter(
    (record) => !record.backfillSafe,
  );
  if (unsafeStandard.length > 0 || unsafeCustom.length > 0) {
    console.log('');
    console.log(
      `Unsafe records skipped: standard=${unsafeStandard.length}, custom=${unsafeCustom.length}`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(
    SettlementBackfillCliModule,
    {
      logger: ['error', 'warn'],
    },
  );

  try {
    const service = app.get(SettlementBackfillService);
    const report = await service.auditAndBackfill(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHuman(report);
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
