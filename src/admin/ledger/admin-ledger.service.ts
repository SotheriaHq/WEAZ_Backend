import { Injectable } from '@nestjs/common';
import { LedgerTransactionType } from '@prisma/client';
import { LedgerService } from 'src/finance/ledger.service';

@Injectable()
export class AdminLedgerService {
  constructor(private readonly ledgerService: LedgerService) {}

  list(params: {
    type?: LedgerTransactionType;
    referenceType?: string;
    referenceId?: string;
    limit?: number;
  }) {
    return this.ledgerService.listTransactions({
      type: params.type,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      take: params.limit,
    });
  }
}
