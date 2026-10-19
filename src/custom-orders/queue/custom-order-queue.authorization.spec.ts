import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import * as request from 'supertest';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { AdminPermissionGuard } from 'src/admin/guards/admin-permission.guard';
import { PrismaService } from 'src/prisma/prisma.service';
import { CustomOrderQueueService } from './custom-order-queue.service';
import { CustomOrderQueueRefundsService } from './custom-order-queue-refunds.service';
import { AdminCustomOrderQueueController } from './custom-order-queue.controller';

// Authentication is replaced with explicit fixture principals; production role,
// permission, UUID and DTO guards run through the real HTTP pipeline.
describe('admin queue HTTP authorization boundary', () => {
  let app: INestApplication;
  const id = 'b16208ed-705e-44bf-86f8-682cb5eeb573';
  const summary = jest.fn(async () => ({ brandId: id }));
  const cancel = jest.fn(async () => ({ queue: {} }));
  const listRefunds = jest.fn(async () => Array.from({ length: 101 }, (_, index) => ({ id: String(index) })));
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminCustomOrderQueueController],
      providers: [Reflector, RolesGuard, AdminPermissionGuard,
        { provide: CustomOrderQueueService, useValue: { summary, cancel } },
        { provide: PrismaService, useValue: { customOrderQueueRefund: { findMany: listRefunds } } },
        { provide: CustomOrderQueueRefundsService, useValue: {} }],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate(context) {
      const req = context.switchToHttp().getRequest();
      const role = req.headers['x-fixture-role'];
      if (!role) throw new UnauthorizedException();
      req.user = { id, role, permissions: String(req.headers['x-fixture-permissions'] ?? '').split(',') };
      return true;
    } }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => jest.clearAllMocks());

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get(`/admin/custom-order-queue/brands/${id}`).expect(401);
    expect(summary).not.toHaveBeenCalled();
  });
  it.each([Role.User, Role.Admin])('rejects %s without the required read permission', async role => {
    await request(app.getHttpServer()).get(`/admin/custom-order-queue/brands/${id}`).set('x-fixture-role', role).expect(403);
    expect(summary).not.toHaveBeenCalled();
  });
  it('does not let a read-only admin issue refunds', async () => {
    await request(app.getHttpServer()).post(`/admin/custom-order-queue/orders/${id}/cancel`).set('x-fixture-role', Role.Admin).set('x-fixture-permissions', 'brands.read').send({ reason: 'Review cancellation', expectedRevision: 0 }).expect(403);
    expect(cancel).not.toHaveBeenCalled();
  });
  it('permits an authorized read and rejects malformed IDs before service access', async () => {
    await request(app.getHttpServer()).get(`/admin/custom-order-queue/brands/${id}`).set('x-fixture-role', Role.Admin).set('x-fixture-permissions', 'brands.read').expect(200);
    await request(app.getHttpServer()).get('/admin/custom-order-queue/brands/not-a-uuid').set('x-fixture-role', Role.SuperAdmin).expect(400);
    expect(summary).toHaveBeenCalledTimes(1);
  });
  it('rejects injected fields even for a super admin', async () => {
    await request(app.getHttpServer()).post(`/admin/custom-order-queue/orders/${id}/cancel`).set('x-fixture-role', Role.SuperAdmin).send({ reason: 'Review cancellation', expectedRevision: 0, buyerId: 'another-buyer', refundAmount: 999999 }).expect(400);
    expect(cancel).not.toHaveBeenCalled();
  });
  it('paginates refund obligations and validates the cursor before database access', async () => {
    const response = await request(app.getHttpServer()).get('/admin/custom-order-queue/refunds').set('x-fixture-role', Role.Admin).set('x-fixture-permissions', 'disputes.refund').expect(200);
    expect(response.body.refunds).toHaveLength(100);
    expect(response.body.nextCursor).toBe('99');
    listRefunds.mockClear();
    await request(app.getHttpServer()).get('/admin/custom-order-queue/refunds?cursor=malformed').set('x-fixture-role', Role.SuperAdmin).expect(400);
    expect(listRefunds).not.toHaveBeenCalled();
  });
});
