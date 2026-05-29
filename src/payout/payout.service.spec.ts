import { Test, TestingModule } from '@nestjs/testing';
import { PayoutService } from './payout.service';
import { PrismaService } from '../prisma/prisma.service';
import { StandardOrderEscrowService } from 'src/finance/standard-order-escrow.service';
import { CommissionService } from 'src/finance/commission.service';
import { StandardOrderFinanceSyncService } from 'src/finance/standard-order-finance-sync.service';

describe('PayoutService', () => {
  let service: PayoutService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutService,
        { provide: PrismaService, useValue: {} },
        {
          provide: StandardOrderEscrowService,
          useValue: { getReleasedBalance: jest.fn() },
        },
        { provide: CommissionService, useValue: { resolveRule: jest.fn() } },
        {
          provide: StandardOrderFinanceSyncService,
          useValue: { syncPaidOrdersByOrderIds: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<PayoutService>(PayoutService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
