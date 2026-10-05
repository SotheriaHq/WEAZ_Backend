import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { SystemConfigModule } from 'src/admin/system-config/system-config.module';
import { StandardOrderEscrowService } from './standard-order-escrow.service';
import { LedgerService } from './ledger.service';
import { CommissionService } from './commission.service';
import { ReconciliationService } from './reconciliation.service';
import { FinancialDocumentsService } from './financial-documents.service';
import { StandardOrderFinanceSyncService } from './standard-order-finance-sync.service';
import { SettlementPolicyService } from './settlement-policy.service';
import { SettlementCalculatorService } from './settlement-calculator.service';
import { SettlementSnapshotService } from './settlement-snapshot.service';
import { SettlementBackfillService } from './settlement-backfill.service';
import { CustomOrderFinanceSyncService } from './custom-order-finance-sync.service';
import { BrandBalanceService } from './brand-balance.service';

@Module({
  imports: [PrismaModule, SystemConfigModule],
  providers: [
    StandardOrderEscrowService,
    // The brand debt ledger. It was imported into this file and injected in six
    // places across four modules, and listed as a provider by nobody — so the
    // API could not construct `StandardOrderEscrowService` and crash-looped on
    // boot. `tsc` cannot see this and the unit tests all pass, because each
    // spec supplies its own mock; only a real Nest bootstrap catches it.
    BrandBalanceService,
    LedgerService,
    CommissionService,
    ReconciliationService,
    FinancialDocumentsService,
    StandardOrderFinanceSyncService,
    CustomOrderFinanceSyncService,
    SettlementPolicyService,
    SettlementCalculatorService,
    SettlementSnapshotService,
    SettlementBackfillService,
  ],
  exports: [
    StandardOrderEscrowService,
    BrandBalanceService,
    LedgerService,
    CommissionService,
    ReconciliationService,
    FinancialDocumentsService,
    StandardOrderFinanceSyncService,
    CustomOrderFinanceSyncService,
    SettlementPolicyService,
    SettlementCalculatorService,
    SettlementSnapshotService,
    SettlementBackfillService,
  ],
})
export class FinanceModule {}
