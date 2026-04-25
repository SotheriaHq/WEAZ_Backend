import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { SystemConfigModule } from 'src/admin/system-config/system-config.module';
import { StandardOrderEscrowService } from './standard-order-escrow.service';
import { LedgerService } from './ledger.service';
import { CommissionService } from './commission.service';
import { ReconciliationService } from './reconciliation.service';
import { FinancialDocumentsService } from './financial-documents.service';
import { StandardOrderFinanceSyncService } from './standard-order-finance-sync.service';

@Module({
  imports: [PrismaModule, SystemConfigModule],
  providers: [
    StandardOrderEscrowService,
    LedgerService,
    CommissionService,
    ReconciliationService,
    FinancialDocumentsService,
    StandardOrderFinanceSyncService,
  ],
  exports: [
    StandardOrderEscrowService,
    LedgerService,
    CommissionService,
    ReconciliationService,
    FinancialDocumentsService,
    StandardOrderFinanceSyncService,
  ],
})
export class FinanceModule {}
