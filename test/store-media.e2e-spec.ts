import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from './../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { UploadService } from '../src/upload/upload.service';
import { JwtAuthGuard } from '../src/auth/guard/jwt-auth.guard';
import { UserTypeGuard } from '../src/auth/guard/user-type.guard';

describe('Store media rules (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const userId = uuidv4();
  const brandId = uuidv4();

  beforeAll(async () => {
    jest
      .spyOn(JwtAuthGuard.prototype, 'canActivate')
      .mockImplementation((context: any) => {
        const req = context.switchToHttp().getRequest();
        req.user = { id: userId, type: 'BRAND' };
        return true;
      });

    jest
      .spyOn(UserTypeGuard.prototype, 'canActivate')
      .mockImplementation((context: any) => {
        const req = context.switchToHttp().getRequest();
        req.user = { id: userId, type: 'BRAND' };
        return true;
      });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(UploadService)
      .useValue({
        uploadFile: jest.fn(),
        deleteFile: jest.fn(),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);

    await prisma.user.create({
      data: {
        id: userId,
        username: `brand_${userId.slice(0, 6)}`,
        email: `brand_${userId.slice(0, 6)}@example.com`,
        password: 'password123',
        firstName: 'Brand',
        lastName: 'Owner',
        type: 'BRAND',
        role: 'User',
      },
    });

    await prisma.brand.create({
      data: {
        id: brandId,
        name: 'Test Brand',
        ownerId: userId,
        currency: 'NGN',
        isStoreOpen: true,
      },
    });
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { brandId } });
    await prisma.collection.deleteMany({ where: { ownerId: userId } });
    await prisma.fileUpload.deleteMany({ where: { userId } });
    await prisma.brand.deleteMany({ where: { ownerId: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  });

  it('rejects creating a product with more than 4 images', async () => {
    await request(app.getHttpServer())
      .post('/products')
      .send({
        name: 'Too many images',
        price: 1500,
        images: ['a', 'b', 'c', 'd', 'e'],
      })
      .expect(400);
  });

  it('defaults thumbnail to the first image when missing', async () => {
    const response = await request(app.getHttpServer())
      .post('/products')
      .send({
        name: 'Thumbnail default',
        price: 1500,
        images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
      })
      .expect(201);

    expect(response.body.data.thumbnail).toBe('https://example.com/a.jpg');
  });

  it('setting primary updates thumbnail without reordering', async () => {
    const mediaAId = uuidv4();
    const mediaBId = uuidv4();
    const urlA = 'https://example.com/a.jpg';
    const urlB = 'https://example.com/b.jpg';

    await prisma.fileUpload.createMany({
      data: [
        {
          id: mediaAId,
          userId,
          originalName: 'a.jpg',
          fileName: 'a.jpg',
          s3Key: `tests/${mediaAId}`,
          s3Url: urlA,
          fileType: 'POST_IMAGE',
          mimeType: 'image/jpeg',
          size: 123,
        },
        {
          id: mediaBId,
          userId,
          originalName: 'b.jpg',
          fileName: 'b.jpg',
          s3Key: `tests/${mediaBId}`,
          s3Url: urlB,
          fileType: 'POST_IMAGE',
          mimeType: 'image/jpeg',
          size: 123,
        },
      ],
    });

    const createResponse = await request(app.getHttpServer())
      .post('/products')
      .send({
        name: 'Primary update',
        price: 2000,
        images: [urlA, urlB],
        thumbnail: urlA,
      })
      .expect(201);

    const productId = createResponse.body.data.id;

    await request(app.getHttpServer())
      .patch(`/products/${productId}/media/${mediaBId}/primary`)
      .expect(200);

    const updated = await request(app.getHttpServer())
      .get(`/products/${productId}`)
      .expect(200);

    expect(updated.body.data.thumbnail).toBe(urlB);
    expect(updated.body.data.images).toEqual([urlA, urlB]);
  });

  it('deleting the cover selects the next image as cover', async () => {
    const mediaAId = uuidv4();
    const mediaBId = uuidv4();
    const urlA = 'https://example.com/c.jpg';
    const urlB = 'https://example.com/d.jpg';

    await prisma.fileUpload.createMany({
      data: [
        {
          id: mediaAId,
          userId,
          originalName: 'c.jpg',
          fileName: 'c.jpg',
          s3Key: `tests/${mediaAId}`,
          s3Url: urlA,
          fileType: 'POST_IMAGE',
          mimeType: 'image/jpeg',
          size: 123,
        },
        {
          id: mediaBId,
          userId,
          originalName: 'd.jpg',
          fileName: 'd.jpg',
          s3Key: `tests/${mediaBId}`,
          s3Url: urlB,
          fileType: 'POST_IMAGE',
          mimeType: 'image/jpeg',
          size: 123,
        },
      ],
    });

    const createResponse = await request(app.getHttpServer())
      .post('/products')
      .send({
        name: 'Delete cover',
        price: 2500,
        images: [urlA, urlB],
        thumbnail: urlA,
      })
      .expect(201);

    const productId = createResponse.body.data.id;

    await request(app.getHttpServer())
      .delete(`/products/${productId}/media/${mediaAId}`)
      .expect(200);

    const updated = await request(app.getHttpServer())
      .get(`/products/${productId}`)
      .expect(200);

    expect(updated.body.data.thumbnail).toBe(urlB);
    expect(updated.body.data.images).toEqual([urlB]);
  });
});
