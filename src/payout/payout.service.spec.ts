import { Test, TestingModule } from '@nestjs/testing';
import { PayoutService } from './payout.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PayoutService', () => {
  let service: PayoutService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PayoutService, { provide: PrismaService, useValue: {} }],
    }).compile();

    service = module.get<PayoutService>(PayoutService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
