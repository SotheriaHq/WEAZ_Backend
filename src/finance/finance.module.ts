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

@Module({
  imports: [PrismaModule, SystemConfigModule],
  providers: [
    StandardOrderEscrowService,
    LedgerService,
    CommissionService,
    ReconciliationService,
    FinancialDocumentsService,
    StandardOrderFinanceSyncService,
    SettlementPolicyService,
    SettlementCalculatorService,
    SettlementSnapshotService,
  ],
  exports: [
    StandardOrderEscrowService,
    LedgerService,
    CommissionService,
    ReconciliationService,
    FinancialDocumentsService,
    StandardOrderFinanceSyncService,
    SettlementPolicyService,
    SettlementCalculatorService,
    SettlementSnapshotService,
  ],
})
export class FinanceModule {}
