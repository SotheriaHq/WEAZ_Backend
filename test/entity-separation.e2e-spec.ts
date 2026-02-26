import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtAuthGuard } from '../src/auth/guard/jwt-auth.guard';
import { UserTypeGuard } from '../src/auth/guard/user-type.guard';

describe('Entity separation routes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const ownerId = uuidv4();
  const brandId = uuidv4();
  const designId = uuidv4();
  const storeCollectionId = uuidv4();

  beforeAll(async () => {
    jest
      .spyOn(JwtAuthGuard.prototype, 'canActivate')
      .mockImplementation((context: any) => {
        const req = context.switchToHttp().getRequest();
        req.user = { id: ownerId, type: 'BRAND' };
        return true;
      });

    jest
      .spyOn(UserTypeGuard.prototype, 'canActivate')
      .mockImplementation((context: any) => {
        const req = context.switchToHttp().getRequest();
        req.user = { id: ownerId, type: 'BRAND' };
        return true;
      });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);

    await prisma.user.create({
      data: {
        id: ownerId,
        username: `brand_${ownerId.slice(0, 6)}`,
        email: `brand_${ownerId.slice(0, 6)}@example.com`,
        password: 'password123',
        firstName: 'Entity',
        lastName: 'Owner',
        type: 'BRAND',
        role: 'User',
      },
    });

    await prisma.brand.create({
      data: {
        id: brandId,
        name: 'Entity Split Brand',
        ownerId,
        currency: 'NGN',
        isStoreOpen: true,
      },
    });

    await prisma.collection.create({
      data: {
        id: designId,
        ownerId,
        domain: 'DESIGN',
        title: 'Design One',
        description: 'Design entity',
        status: 'PUBLISHED',
        visibility: 'PUBLIC',
        type: 'EVERYBODY',
        tags: ['design-tag'],
        isAvailableInStore: false,
      },
    });

    await prisma.storeCollection.create({
      data: {
        id: storeCollectionId,
        ownerId,
        title: 'Store Collection One',
        description: 'Store collection entity',
        status: 'PUBLISHED',
        visibility: 'PUBLIC',
        type: 'EVERYBODY',
        tags: ['store-tag'],
        isAvailableInStore: true,
        isSystemGenerated: false,
      },
    });
  });

  afterAll(async () => {
    await prisma.storeCollection.deleteMany({ where: { ownerId } });
    await prisma.collection.deleteMany({ where: { ownerId } });
    await prisma.brand.deleteMany({ where: { ownerId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await app.close();
  });

  it('lists only design entities via /designs/user/:userId', async () => {
    const response = await request(app.getHttpServer())
      .get(`/designs/user/${ownerId}`)
      .expect(200);

    const payload = response.body?.data ?? response.body;
    const items = payload?.items ?? [];

    expect(Array.isArray(items)).toBe(true);
    expect(items.some((item: any) => item.id === designId)).toBe(true);
    expect(items.some((item: any) => item.id === storeCollectionId)).toBe(false);
  });

  it('lists only store-collection entities via /store-collections/user/:userId', async () => {
    const response = await request(app.getHttpServer())
      .get(`/store-collections/user/${ownerId}`)
      .expect(200);

    const payload = response.body?.data ?? response.body;
    const items = payload?.items ?? [];

    expect(Array.isArray(items)).toBe(true);
    expect(items.some((item: any) => item.id === storeCollectionId)).toBe(true);
    expect(items.some((item: any) => item.id === designId)).toBe(false);
  });

  it('updates design without mutating store collection', async () => {
    await request(app.getHttpServer())
      .patch(`/designs/${designId}`)
      .send({ title: 'Design Updated' })
      .expect(200);

    const design = await prisma.collection.findUnique({ where: { id: designId } });
    const storeCollection = await prisma.storeCollection.findUnique({
      where: { id: storeCollectionId },
    });

    expect(design?.title).toBe('Design Updated');
    expect(storeCollection?.title).toBe('Store Collection One');
  });

  it('updates store collection without mutating design', async () => {
    await request(app.getHttpServer())
      .patch(`/store-collections/${storeCollectionId}`)
      .send({ title: 'Store Collection Updated' })
      .expect(200);

    const design = await prisma.collection.findUnique({ where: { id: designId } });
    const storeCollection = await prisma.storeCollection.findUnique({
      where: { id: storeCollectionId },
    });

    expect(storeCollection?.title).toBe('Store Collection Updated');
    expect(design?.title).toBe('Design Updated');
  });

  it('soft deletes design without deleting store collection', async () => {
    await request(app.getHttpServer()).delete(`/designs/${designId}`).expect(200);

    const design = await prisma.collection.findUnique({ where: { id: designId } });
    const storeCollection = await prisma.storeCollection.findUnique({
      where: { id: storeCollectionId },
    });

    expect(design?.deletedAt).toBeTruthy();
    expect(storeCollection?.deletedAt).toBeNull();
  });

  it('initializes and finalizes store collection draft via explicit store endpoint', async () => {
    const initResp = await request(app.getHttpServer())
      .post('/store-collections/initialize')
      .send({
        mode: 'existing',
        title: 'Store Draft Session',
        description: 'Draft via store endpoint',
        visibility: 'PUBLIC',
        type: 'EVERYBODY',
        tags: ['draft-store'],
      })
      .expect(201);

    const initPayload = initResp.body?.data ?? initResp.body;
    const sessionId =
      initPayload?.sessionId ?? initPayload?.collectionId ?? initPayload?.id;

    expect(typeof sessionId).toBe('string');

    await request(app.getHttpServer())
      .post(`/store-collections/${sessionId}/finalize`)
      .send({
        action: 'draft',
        collectionMetadata: {
          title: 'Store Draft Session',
          description: 'Draft via store endpoint',
          visibility: 'PUBLIC',
          type: 'EVERYBODY',
          tags: ['draft-store'],
        },
      })
      .expect(201);

    const stored = await prisma.storeCollection.findUnique({ where: { id: sessionId } });
    expect(stored).toBeTruthy();
    expect(stored?.ownerId).toBe(ownerId);
  });
});
