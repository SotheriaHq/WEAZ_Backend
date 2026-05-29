import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  AdminAuditAction,
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  EscrowHoldStatus,
  LedgerEntryDirection,
  SettlementFinalReleaseTrigger,
  SettlementOrderType,
  SettlementPolicyScope,
  SettlementReleaseMode,
} from '@prisma/client';
import { AdminFinanceService } from './admin-finance.service';

describe('AdminFinanceService settlement policy management', () => {
  let service: AdminFinanceService;
  let prisma: any;
  let settlementPolicyService: any;
  let settlementCalculatorService: any;
  let ledgerService: any;

  const req: any = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'user-agent': 'jest-agent' },
  };

  beforeEach(() => {
    prisma = {
      adminAuditLog: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      settlementSnapshot: {
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      escrowHold: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      customOrderLedgerAllocation: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      ledgerEntry: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      payout: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
        count: jest.fn().mockResolvedValue(0),
      },
      paymentAttempt: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { settlementAmount: 0, amount: 0 } }),
      },
      ledgerTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { totalAmount: 0 } }),
      },
      commissionRule: {
        count: jest.fn().mockResolvedValue(0),
      },
      reconciliationItem: {
        count: jest.fn().mockResolvedValue(0),
      },
    };

    settlementPolicyService = {
      listPolicies: jest.fn().mockResolvedValue([{ id: 'policy_1' }]),
      getPolicy: jest.fn(),
      createPolicy: jest.fn(),
      updatePolicy: jest.fn(),
      deactivatePolicy: jest.fn(),
      activatePolicy: jest.fn(),
      resolveActivePolicy: jest.fn(),
    };

    settlementCalculatorService = {
      calculate: jest.fn(),
    };

    ledgerService = {
      postCustomOrderFinalRelease: jest.fn(),
    };

    service = new AdminFinanceService(
      prisma,
      { listRules: jest.fn().mockResolvedValue([]) } as any,
      { getNumber: jest.fn().mockResolvedValue(0) } as any,
      {
        listRuns: jest.fn().mockResolvedValue([]),
        listItems: jest.fn().mockResolvedValue([]),
      } as any,
      { listDocuments: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
      ledgerService,
      settlementPolicyService,
      settlementCalculatorService,
    );
  });

  it('lists settlement policies with filters', async () => {
    const result = await service.listSettlementPolicies({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      scope: SettlementPolicyScope.PLATFORM,
      currency: 'NGN',
      isActive: true,
    });

    expect(settlementPolicyService.listPolicies).toHaveBeenCalledWith({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      scope: SettlementPolicyScope.PLATFORM,
      currency: 'NGN',
      isActive: true,
    });
    expect(result).toEqual([{ id: 'policy_1' }]);
  });

  it('creates a valid settlement policy and writes an audit log', async () => {
    const created = {
      id: 'policy_created',
      orderType: SettlementOrderType.CUSTOM_ORDER,
      releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
      upfrontReleaseEnabled: true,
      upfrontReleasePercent: 50,
    };
    settlementPolicyService.createPolicy.mockResolvedValue(created);

    await service.createSettlementPolicy('admin_1', req, {
      orderType: SettlementOrderType.CUSTOM_ORDER,
      releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
      upfrontReleaseEnabled: true,
      upfrontReleasePercent: 50,
    });

    expect(settlementPolicyService.createPolicy).toHaveBeenCalledWith(
      'admin_1',
      expect.objectContaining({
        orderType: SettlementOrderType.CUSTOM_ORDER,
        upfrontReleasePercent: 50,
      }),
    );
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: 'admin_1',
        action: AdminAuditAction.ADMIN_SYSTEM_SETTINGS_UPDATE,
        targetType: 'SettlementPolicy',
        targetId: 'policy_created',
        newState: created,
        ipAddress: '127.0.0.1',
        userAgent: 'jest-agent',
      }),
    });
  });

  it('rejects invalid hold-until-delivery settlement policies', async () => {
    settlementPolicyService.createPolicy.mockRejectedValue(
      new BadRequestException(
        'HOLD_UNTIL_DELIVERY policies must use an upfrontReleasePercent of 0',
      ),
    );

    await expect(
      service.createSettlementPolicy('admin_1', req, {
        orderType: SettlementOrderType.STANDARD_ORDER,
        releaseMode: SettlementReleaseMode.HOLD_UNTIL_DELIVERY,
        upfrontReleaseEnabled: false,
        upfrontReleasePercent: 10,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('rejects overlapping ambiguous active settlement policies', async () => {
    settlementPolicyService.createPolicy.mockRejectedValue(
      new ConflictException(
        'An active settlement policy already overlaps this order type, scope, brand, currency, and effective window',
      ),
    );

    await expect(
      service.createSettlementPolicy('admin_1', req, {
        orderType: SettlementOrderType.CUSTOM_ORDER,
        scope: SettlementPolicyScope.BRAND,
        brandId: 'brand_1',
        currency: 'NGN',
        releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
        upfrontReleaseEnabled: true,
        upfrontReleasePercent: 55,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns a read-only settlement preview without writing snapshots or ledger data', async () => {
    settlementPolicyService.resolveActivePolicy.mockResolvedValue({
      id: 'policy_60',
      orderType: SettlementOrderType.CUSTOM_ORDER,
      releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
      upfrontReleaseEnabled: true,
      upfrontReleasePercent: 60,
      settlementDelayHours: 48,
      autoReleaseDays: 7,
      finalReleaseTrigger: SettlementFinalReleaseTrigger.BUYER_CONFIRMATION,
    });
    settlementCalculatorService.calculate.mockResolvedValue({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      brandId: 'brand_1',
      grossAmount: 1000,
      currency: 'NGN',
      commissionRuleId: 'commission_1',
      commissionSource: 'RULE',
      commissionScope: 'PLATFORM',
      commissionRate: 10,
      commissionAmount: 100,
      brandNetAmount: 900,
      settlementPolicyId: 'policy_60',
      releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
      upfrontReleaseEnabled: true,
      upfrontReleasePercent: 60,
      upfrontReleaseGrossAmount: 600,
      finalReleaseGrossAmount: 400,
    });

    const result = await service.previewSettlementPolicy({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      brandId: 'brand_1',
      currency: 'NGN',
      amount: 1000,
      effectiveAt: '2026-05-05T10:00:00.000Z',
    });

    expect(result.writesSnapshot).toBe(false);
    expect(result.writesLedger).toBe(false);
    expect(result.resolvedSettlementPolicy.id).toBe('policy_60');
    expect(result.settlementBreakdown.upfrontReleaseGrossAmount).toBe(600);
    expect(prisma.settlementSnapshot.create).not.toHaveBeenCalled();
    expect(ledgerService.postCustomOrderFinalRelease).not.toHaveBeenCalled();
  });

  it('updates settlement policy without mutating existing snapshots', async () => {
    const existing = {
      id: 'policy_1',
      orderType: SettlementOrderType.CUSTOM_ORDER,
    };
    const updated = {
      ...existing,
      upfrontReleasePercent: 50,
    };
    settlementPolicyService.getPolicy.mockResolvedValue(existing);
    settlementPolicyService.updatePolicy.mockResolvedValue(updated);

    await service.updateSettlementPolicy('policy_1', 'admin_1', req, {
      upfrontReleasePercent: 50,
    });

    expect(settlementPolicyService.updatePolicy).toHaveBeenCalled();
    expect(prisma.settlementSnapshot.update).not.toHaveBeenCalled();
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        targetType: 'SettlementPolicy',
        targetId: 'policy_1',
        previousState: existing,
        newState: updated,
      }),
    });
  });

  it('includes settlement-state fields in finance overview', async () => {
    prisma.escrowHold.findMany.mockResolvedValue([
      {
        status: EscrowHoldStatus.PARTIALLY_RELEASED,
        totalAmount: 1000,
        firstReleaseAmount: 300,
        secondReleaseAmount: 700,
        firstReleasedAt: new Date('2026-05-05T10:00:00.000Z'),
        secondReleasedAt: null,
        secondReleaseEligibleAt: new Date('2099-05-06T10:00:00.000Z'),
      },
      {
        status: EscrowHoldStatus.FROZEN,
        totalAmount: 500,
        firstReleaseAmount: 0,
        secondReleaseAmount: 500,
        firstReleasedAt: null,
        secondReleasedAt: null,
        secondReleaseEligibleAt: null,
      },
    ]);
    prisma.customOrderLedgerAllocation.findMany.mockResolvedValue([
      {
        allocationType:
          CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
        amount: 600,
        status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
      },
      {
        allocationType:
          CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
        amount: 400,
        status: CustomOrderLedgerAllocationStatus.HELD,
      },
    ]);
    prisma.ledgerEntry.findMany.mockResolvedValue([
      { direction: LedgerEntryDirection.CREDIT, amount: 900 },
      { direction: LedgerEntryDirection.DEBIT, amount: 100 },
    ]);
    prisma.payout.aggregate
      .mockResolvedValueOnce({ _sum: { amount: 250 } })
      .mockResolvedValueOnce({ _sum: { amount: 120 } })
      .mockResolvedValueOnce({ _sum: { amount: 80 } });

    const overview = await service.getOverview();

    expect(overview.settlementState).toEqual(
      expect.objectContaining({
        totalHeldFunds: 1100,
        upfrontReleasedFunds: 900,
        finalReleasePendingFunds: 1100,
        frozenFunds: 500,
        availableBrandWalletFunds: 800,
        payoutPendingFunds: 120,
        paidOutFunds: 80,
      }),
    );
  });
});
