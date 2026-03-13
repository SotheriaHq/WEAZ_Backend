import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { v4 as uuidv4 } from 'uuid';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtAuthGuard } from '../src/auth/guard/jwt-auth.guard';
import { RolesGuard } from '../src/auth/guard/role.guard';
import { AdminPermissionGuard } from '../src/admin/guards/admin-permission.guard';

describe('Custom-order admin reconciliation routes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const adminId = uuidv4();
  const ownerId = uuidv4();
  const buyerId = uuidv4();
  const brandId = uuidv4();
  const basisId = uuidv4();
  const offerId = uuidv4();
  const offerVersionId = uuidv4();
  const customOrderId = uuidv4();
  const payoutId = uuidv4();
  const allocationId = uuidv4();

  beforeAll(async () => {
    jest.spyOn(JwtAuthGuard.prototype, 'canActivate').mockImplementation((context: any) => {
      const req = context.switchToHttp().getRequest();
      req.user = {
        id: adminId,
        sub: adminId,
        role: 'SuperAdmin',
        type: 'REGULAR',
        permissions: ['payouts.read', 'system.data_retention.write'],
      };
      return true;
    });

    jest.spyOn(RolesGuard.prototype, 'canActivate').mockImplementation((context: any) => {
      const req = context.switchToHttp().getRequest();
      req.user = {
        id: adminId,
        sub: adminId,
        role: 'SuperAdmin',
        type: 'REGULAR',
        permissions: ['payouts.read', 'system.data_retention.write'],
      };
      return true;
    });

    jest.spyOn(AdminPermissionGuard.prototype, 'canActivate').mockImplementation(() => true);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);

    await prisma.user.createMany({
      data: [
        {
          id: adminId,
          username: `admin_${adminId.slice(0, 6)}`,
          email: `admin_${adminId.slice(0, 6)}@example.com`,
          password: 'password123',
          firstName: 'Admin',
          lastName: 'Operator',
          type: 'REGULAR',
          role: 'SuperAdmin',
        },
        {
          id: ownerId,
          username: `brand_${ownerId.slice(0, 6)}`,
          email: `brand_${ownerId.slice(0, 6)}@example.com`,
          password: 'password123',
          firstName: 'Brand',
          lastName: 'Owner',
          type: 'BRAND',
          role: 'User',
        },
        {
          id: buyerId,
          username: `buyer_${buyerId.slice(0, 6)}`,
          email: `buyer_${buyerId.slice(0, 6)}@example.com`,
          password: 'password123',
          firstName: 'Buyer',
          lastName: 'User',
          type: 'REGULAR',
          role: 'User',
        },
      ],
    });

    await prisma.brand.create({
      data: {
        id: brandId,
        name: 'Custom Order Brand',
        ownerId,
        currency: 'NGN',
        isStoreOpen: true,
      },
    });

    await prisma.customFabricRuleBasis.create({
      data: {
        id: basisId,
        label: 'Jacket basis',
        measurementKeys: ['chest', 'waist'],
        brandId,
      },
    });

    await prisma.customOrderOffer.create({
      data: {
        id: offerId,
        brandId,
        sourceType: 'PRODUCT',
        sourceId: uuidv4(),
        title: 'Custom Jacket Offer',
        requiredMeasurementKeys: ['chest', 'waist'],
        requiredFreeformPointIds: [],
        fabricRuleBasisId: basisId,
        baseProductionCharge: 1200,
        fabricCostPerYard: 300,
        productionLeadDays: 10,
        deliveryMinDays: 2,
        deliveryMaxDays: 5,
        deliveryScope: 'NATIONWIDE',
        revisionPolicy: 'Two revisions',
        returnPolicy: 'No returns',
        defectPolicy: 'Fix defects',
        fabricSourcingMode: 'BRAND_SOURCED',
      },
    });

    await prisma.customOrderOfferVersion.create({
      data: {
        id: offerVersionId,
        offerId,
        version: 1,
        snapshotJson: { title: 'Custom Jacket Offer' },
        createdById: ownerId,
      },
    });

    await prisma.customOrder.create({
      data: {
        id: customOrderId,
        brandId,
        buyerId,
        sourceType: 'PRODUCT',
        sourceId: uuidv4(),
        sourceTitleSnapshot: 'Custom Jacket',
        sourceSlugSnapshot: 'custom-jacket',
        sourceBrandNameSnapshot: 'Custom Order Brand',
        offerId,
        offerVersionId,
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        paymentMethod: 'PAYSTACK',
        paymentReference: 'co-e2e-ref-1',
        currency: 'NGN',
        baseProductionChargeSnapshot: 1200,
        fabricCostPerYardSnapshot: 300,
        computedYards: 2,
        internalPriceBreakdownJson: { subtotal: 1800 },
        buyerPriceSummaryJson: { grandTotal: 1800, currency: 'NGN' },
        measurementSnapshotJson: { chest: 40, waist: 32 },
        measurementConfirmedAt: new Date('2026-03-12T08:00:00.000Z'),
        productionLeadDaysSnapshot: 10,
        deliveryMinDaysSnapshot: 2,
        deliveryMaxDaysSnapshot: 5,
        contactInfoJson: { email: 'buyer@example.com' },
        currentProgressStage: 'READY_FOR_DELIVERY',
        buyerAcceptedAt: new Date('2026-03-12T10:00:00.000Z'),
        completedAt: new Date('2026-03-12T10:00:00.000Z'),
        measurementRetentionUntil: new Date('2026-03-15T00:00:00.000Z'),
      },
    });

    await prisma.payout.create({
      data: {
        id: payoutId,
        brandId,
        amount: 600,
        currency: 'NGN',
        status: 'PENDING',
        reference: 'CO-batch-test',
      },
    });

    await prisma.customOrderLedgerAllocation.create({
      data: {
        id: allocationId,
        customOrderId,
        payoutId,
        allocationType: 'FINAL_COMPLETION_PORTION',
        amount: 600,
        currency: 'NGN',
        status: 'PAYOUT_ELIGIBLE',
        eligibleAt: new Date('2026-03-12T10:00:00.000Z'),
        paidOutAt: new Date('2026-03-12T12:00:00.000Z'),
      },
    });
  });

  afterAll(async () => {
    await prisma.customOrderLedgerAllocation.deleteMany({ where: { id: allocationId } });
    await prisma.payout.deleteMany({ where: { id: payoutId } });
    await prisma.customOrder.deleteMany({ where: { id: customOrderId } });
    await prisma.customOrderOfferVersion.deleteMany({ where: { id: offerVersionId } });
    await prisma.customOrderOffer.deleteMany({ where: { id: offerId } });
    await prisma.customFabricRuleBasis.deleteMany({ where: { id: basisId } });
    await prisma.brand.deleteMany({ where: { id: brandId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, ownerId, buyerId] } } });
    await app.close();
  });

  it('lists payout-linked ledger allocations for a custom order', async () => {
    const response = await request(app.getHttpServer())
      .get(`/admin/custom-order-ledger-allocations?customOrderId=${customOrderId}`)
      .expect(200);

    const payload = response.body?.data ?? response.body;
    expect(payload.total).toBe(1);
    expect(payload.items[0]).toEqual(
      expect.objectContaining({
        id: allocationId,
        payoutId,
        payout: expect.objectContaining({ id: payoutId, status: 'PENDING' }),
      }),
    );
  });

  it('applies and clears a retention hold on a custom order', async () => {
    const applyResponse = await request(app.getHttpServer())
      .patch(`/admin/custom-orders/${customOrderId}/retention-hold`)
      .send({
        clear: false,
        holdType: 'LEGAL',
        reason: 'Chargeback evidence preservation',
        holdUntil: '2026-04-01T00:00:00.000Z',
      })
      .expect(200);

    const applyPayload = applyResponse.body?.data ?? applyResponse.body;
    expect(applyPayload.retentionHoldType).toBe('LEGAL');

    const storedAfterApply = await prisma.customOrder.findUnique({ where: { id: customOrderId } });
    expect(storedAfterApply?.retentionHoldType).toBe('LEGAL');
    expect(storedAfterApply?.retentionHoldReason).toBe('Chargeback evidence preservation');

    const clearResponse = await request(app.getHttpServer())
      .patch(`/admin/custom-orders/${customOrderId}/retention-hold`)
      .send({ clear: true })
      .expect(200);

    const clearPayload = clearResponse.body?.data ?? clearResponse.body;
    expect(clearPayload.retentionHoldType).toBeNull();

    const storedAfterClear = await prisma.customOrder.findUnique({ where: { id: customOrderId } });
    expect(storedAfterClear?.retentionHoldType).toBeNull();
    expect(storedAfterClear?.retentionHoldReason).toBeNull();
  });
});