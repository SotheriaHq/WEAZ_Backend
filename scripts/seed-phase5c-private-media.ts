import 'dotenv/config';
import { randomUUID } from 'crypto';
import { mkdir, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import * as argon2 from 'argon2';
import {
  BrandMemberRole,
  BrandMemberStatus,
  CollectionStatus,
  CollectionType,
  CollectionVisibility,
  FileType,
  ImageProcessingStatus,
  Role,
  UserStatus,
  UserType,
} from '@prisma/client';
import { createScriptPrismaClient } from './helpers/create-script-prisma';

const REQUIRED_FLAG = 'THREADLY_PHASE5C_PRIVATE_MEDIA_FIXTURE';
const OWNER_EMAIL = 'brand@example.com';
const UNAUTHORIZED_EMAIL = 'phase5c.unauthorized@threadly.test';
const PASSWORD = 'Password123!';

const ids = {
  ownerFallback: '5c5c0000-0000-4000-8000-000000000001',
  unauthorizedUser: '5c5c0000-0000-4000-8000-000000000002',
  ownerProfile: '5c5c0000-0000-4000-8000-000000000003',
  unauthorizedProfile: '5c5c0000-0000-4000-8000-000000000004',
  brand: '5c5c0000-0000-4000-8000-000000000005',
  brandMember: '5c5c0000-0000-4000-8000-000000000006',
  file: '5c5c0000-0000-4000-8000-000000000105',
  design: '5c5c0000-0000-4000-8000-000000000104',
  designMedia: '5c5c0000-0000-4000-8000-000000000106',
};

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

function isSafeLocalDatabaseUrl(raw?: string): boolean {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function resolvePublicBaseUrl(): string {
  return (
    process.env.APP_PUBLIC_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.APP_URL ||
    'http://localhost:3040'
  ).replace(/\/+$/, '');
}

function assertSafeToRun() {
  const flag = String(process.env[REQUIRED_FLAG] || '').toLowerCase();
  if (!['1', 'true', 'yes'].includes(flag)) {
    throw new Error(`Set ${REQUIRED_FLAG}=1 to create or remove the local Phase 5C fixture.`);
  }
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('Phase 5C fixture seeding is disabled in production.');
  }
  if (!isSafeLocalDatabaseUrl(process.env.DATABASE_URL)) {
    throw new Error('Phase 5C fixture seeding only runs against a localhost database URL.');
  }
}

async function rollback(prisma: ReturnType<typeof createScriptPrismaClient>['prisma']) {
  await prisma.design.updateMany({
    where: { id: ids.design },
    data: { coverMediaId: null },
  });
  await prisma.designMedia.deleteMany({ where: { id: ids.designMedia } });
  await prisma.design.deleteMany({ where: { id: ids.design } });
  await prisma.fileUpload.deleteMany({ where: { id: ids.file } });
  await prisma.brandMember.deleteMany({ where: { id: ids.brandMember } });
  await prisma.brand.deleteMany({ where: { id: ids.brand, ownerId: ids.ownerFallback } });
  await prisma.userProfile.deleteMany({
    where: { userId: { in: [ids.ownerFallback, ids.unauthorizedUser] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [ids.ownerFallback, ids.unauthorizedUser] } },
  });

  const diskPath = join(process.cwd(), 'uploads', 'POST_IMAGE', ids.ownerFallback, `${ids.file}.png`);
  await rm(diskPath, { force: true });
}

async function upsertUser(
  prisma: ReturnType<typeof createScriptPrismaClient>['prisma'],
  args: {
    id: string;
    email: string;
    username: string;
    firstName: string;
    lastName: string;
    type: UserType;
  },
) {
  const password = await argon2.hash(PASSWORD);
  const user = await prisma.user.upsert({
    where: { email: args.email },
    update: {
      username: args.username,
      type: args.type,
      role: Role.User,
      status: UserStatus.ACTIVE,
      isActive: 'Active',
      isEmailVerified: true,
      mustResetPassword: false,
    },
    create: {
      id: args.id,
      email: args.email,
      username: args.username,
      password,
      type: args.type,
      role: Role.User,
      status: UserStatus.ACTIVE,
      isActive: 'Active',
      isEmailVerified: true,
      mustResetPassword: false,
    },
    select: { id: true, email: true },
  });

  await prisma.userProfile.upsert({
    where: { userId: user.id },
    update: { firstName: args.firstName, lastName: args.lastName },
    create: {
      id: user.id === args.id ? (args.id === ids.ownerFallback ? ids.ownerProfile : ids.unauthorizedProfile) : randomUUID(),
      userId: user.id,
      firstName: args.firstName,
      lastName: args.lastName,
    },
  });

  return user;
}

async function main() {
  assertSafeToRun();

  const rollbackRequested = process.argv.includes('--rollback');
  const { prisma, disconnect } = createScriptPrismaClient();
  try {
    if (rollbackRequested) {
      await rollback(prisma);
      console.log(JSON.stringify({ rolledBack: true, fixtureDesignId: ids.design, fixtureFileId: ids.file }));
      return;
    }

    const owner =
      (await prisma.user.findUnique({
        where: { email: OWNER_EMAIL },
        select: { id: true, email: true, brand: { select: { id: true } } },
      })) ??
      (await upsertUser(prisma, {
        id: ids.ownerFallback,
        email: OWNER_EMAIL,
        username: 'phase5c_brand_owner',
        firstName: 'Phase',
        lastName: 'Owner',
        type: UserType.BRAND,
      }));

    await upsertUser(prisma, {
      id: ids.unauthorizedUser,
      email: UNAUTHORIZED_EMAIL,
      username: 'phase5c_unauthorized',
      firstName: 'Phase',
      lastName: 'Unauthorized',
      type: UserType.REGULAR,
    });

    const brand = await prisma.brand.upsert({
      where: { ownerId: owner.id },
      update: {
        name: 'Phase 5C Private Fixture Brand',
        isStoreOpen: true,
        currency: 'NGN',
      },
      create: {
        id: ids.brand,
        ownerId: owner.id,
        name: 'Phase 5C Private Fixture Brand',
        description: 'Local-only validation brand for private signed media.',
        isStoreOpen: true,
        currency: 'NGN',
      },
      select: { id: true },
    });

    await prisma.brandMember.upsert({
      where: { brandId_userId: { brandId: brand.id, userId: owner.id } },
      update: {
        role: BrandMemberRole.OWNER,
        status: BrandMemberStatus.ACTIVE,
      },
      create: {
        id: ids.brandMember,
        userId: owner.id,
        brandId: brand.id,
        role: BrandMemberRole.OWNER,
        status: BrandMemberStatus.ACTIVE,
      },
    });

    const s3Key = `POST_IMAGE/${owner.id}/${ids.file}.png`;
    const diskPath = join(process.cwd(), 'uploads', s3Key);
    await mkdir(dirname(diskPath), { recursive: true });
    await writeFile(diskPath, pngBytes);

    const publicBaseUrl = resolvePublicBaseUrl();
    const s3Url = `${publicBaseUrl}/uploads/${s3Key}`;

    await prisma.fileUpload.upsert({
      where: { id: ids.file },
      update: {
        userId: owner.id,
        originalName: 'phase-5c-private.png',
        fileName: `${ids.file}.png`,
        s3Key,
        s3Url,
        fileType: FileType.POST_IMAGE,
        mimeType: 'image/png',
        size: pngBytes.length,
        processingStatus: ImageProcessingStatus.READY,
        width: 1,
        height: 1,
        isPublic: false,
        originalDeletedAt: null,
      },
      create: {
        id: ids.file,
        userId: owner.id,
        originalName: 'phase-5c-private.png',
        fileName: `${ids.file}.png`,
        s3Key,
        s3Url,
        fileType: FileType.POST_IMAGE,
        mimeType: 'image/png',
        size: pngBytes.length,
        processingStatus: ImageProcessingStatus.READY,
        width: 1,
        height: 1,
        isPublic: false,
      },
    });

    await prisma.design.upsert({
      where: { id: ids.design },
      update: {
        ownerId: owner.id,
        brandId: brand.id,
        title: 'Phase 5C Private Media Fixture',
        description: 'Local-only private media validation fixture.',
        status: CollectionStatus.PUBLISHED,
        visibility: CollectionVisibility.PRIVATE,
        type: CollectionType.EVERYBODY,
      },
      create: {
        id: ids.design,
        ownerId: owner.id,
        brandId: brand.id,
        title: 'Phase 5C Private Media Fixture',
        description: 'Local-only private media validation fixture.',
        status: CollectionStatus.PUBLISHED,
        visibility: CollectionVisibility.PRIVATE,
        type: CollectionType.EVERYBODY,
      },
    });

    await prisma.designMedia.upsert({
      where: { id: ids.designMedia },
      update: {
        designId: ids.design,
        fileUploadId: ids.file,
        orderIndex: 0,
        mediaType: FileType.POST_IMAGE,
      },
      create: {
        id: ids.designMedia,
        designId: ids.design,
        fileUploadId: ids.file,
        orderIndex: 0,
        mediaType: FileType.POST_IMAGE,
      },
    });

    await prisma.design.update({
      where: { id: ids.design },
      data: { coverMediaId: ids.designMedia },
    });

    console.log(
      JSON.stringify({
        created: true,
        ownerEmail: owner.email,
        unauthorizedEmail: UNAUTHORIZED_EMAIL,
        fixtureDesignId: ids.design,
        fixtureFileId: ids.file,
        route: `/designs/${ids.design}`,
        rollback: `set ${REQUIRED_FLAG}=1 && npm run seed:phase5c:private-media -- --rollback`,
      }),
    );
  } finally {
    await disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
