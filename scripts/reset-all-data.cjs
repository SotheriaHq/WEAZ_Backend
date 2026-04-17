#!/usr/bin/env node
require('dotenv/config');

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');

function parseArgs(argv) {
  const flags = new Set(argv.filter((value) => value.startsWith('--')));
  return {
    confirm: flags.has('--confirm'),
    skipDb: flags.has('--skip-db'),
    skipBucket: flags.has('--skip-bucket'),
    skipLocalUploads: flags.has('--skip-local-uploads'),
    skipSeed: flags.has('--skip-seed'),
  };
}

function getBucketName() {
  return process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || '';
}

function getRegion() {
  return process.env.AWS_REGION || process.env.REGION || 'eu-north-1';
}

function createS3Client(region) {
  const accessKeyId =
    process.env.AWS_ACCESS_KEY_ID || process.env.ACCESS_KEY_ID || undefined;
  const secretAccessKey =
    process.env.AWS_SECRET_ACCESS_KEY || process.env.SECRET_ACCESS_KEY || undefined;

  const config = { region };
  if (accessKeyId && secretAccessKey) {
    config.credentials = { accessKeyId, secretAccessKey };
  }

  return new S3Client(config);
}

async function emptyBucket(bucketName, region) {
  if (!bucketName) {
    throw new Error('AWS_S3_BUCKET (or S3_BUCKET) must be configured to wipe S3.');
  }

  const s3 = createS3Client(region);
  let continuationToken = undefined;
  let deletedCount = 0;

  do {
    const listResponse = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken: continuationToken,
      }),
    );

    const objects = (listResponse.Contents || [])
      .map((item) => item && item.Key)
      .filter(Boolean)
      .map((Key) => ({ Key }));

    if (objects.length > 0) {
      const deleteResponse = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: {
            Objects: objects,
            Quiet: true,
          },
        }),
      );

      if (deleteResponse.Errors && deleteResponse.Errors.length > 0) {
        const sample = deleteResponse.Errors.slice(0, 3)
          .map((item) => `${item.Key || 'unknown'}:${item.Code || 'ERR'}`)
          .join(', ');
        throw new Error(`S3 deleteObjects reported errors: ${sample}`);
      }

      deletedCount += objects.length;
    }

    continuationToken = listResponse.IsTruncated
      ? listResponse.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return deletedCount;
}

function removeLocalUploads() {
  const uploadsPath = path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsPath)) {
    return { removed: false, path: uploadsPath };
  }

  fs.rmSync(uploadsPath, { recursive: true, force: true });
  return { removed: true, path: uploadsPath };
}

function runCommand(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function resetDatabase() {
  const args = ['prisma', 'migrate', 'reset', '--force'];
  runCommand('npx', args, 'Prisma reset');
}

function runSeed() {
  runCommand('npm', ['run', 'prisma:seed'], 'Database seed');
}

function verifySeededAdmin() {
  const result = spawnSync(
    'node',
    [
      '-e',
      [
        "require('dotenv/config');",
        "const { PrismaClient } = require('@prisma/client');",
        "const { PrismaPg } = require('@prisma/adapter-pg');",
        "const { Pool } = require('pg');",
        "const pool = new Pool({ connectionString: process.env.DATABASE_URL });",
        "const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });",
        "(async () => {",
        "  const superAdminEmail = 'adminoversee@test.com';",
        "  const disallowedSeedEmails = ['brand@example.com'];",
        "  const disallowedSeedUsernames = ['brand_demo'];",
        "  const superAdmin = await prisma.user.findUnique({",
        "    where: { email: superAdminEmail },",
        "    select: { id: true, role: true, status: true },",
        "  });",
        "  if (!superAdmin || superAdmin.role !== 'SuperAdmin' || superAdmin.status !== 'ACTIVE') {",
        "    throw new Error('Seeded SuperAdmin missing or invalid after reset');",
        "  }",
        "  const nonSuperAdminCount = await prisma.user.count({",
        "    where: { email: { not: superAdminEmail } },",
        "  });",
        "  if (nonSuperAdminCount > 0) {",
        "    throw new Error(`Expected only SuperAdmin after reset seed, found ${nonSuperAdminCount} extra user(s)`);",
        "  }",
        "  const disallowedSeedUsers = await prisma.user.findMany({",
        "    where: {",
        "      OR: [",
        "        { email: { in: disallowedSeedEmails } },",
        "        { username: { in: disallowedSeedUsernames } },",
        "      ],",
        "    },",
        "    select: { email: true, username: true },",
        "  });",
        "  if (disallowedSeedUsers.length > 0) {",
        "    throw new Error('Disallowed seed demo users detected after reset');",
        "  }",
        "  console.log(`Verified seeded SuperAdmin only: ${superAdminEmail}`);",
        '})()',
        "  .catch(async (error) => {",
        "    console.error(error instanceof Error ? error.message : String(error));",
        "    process.exitCode = 1;",
        '  })',
        "  .finally(async () => {",
        "    await prisma.$disconnect().catch(() => undefined);",
        "    await pool.end().catch(() => undefined);",
        '  });',
      ].join(' '),
    ],
    {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: true,
      env: process.env,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `Seed verification failed with exit code ${result.status ?? 'unknown'}`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bucketName = getBucketName();
  const region = getRegion();
  const databaseUrl = process.env.DATABASE_URL || '';

  if (!options.confirm) {
    console.error('Refusing to run without --confirm.');
    console.error('This command deletes database data, S3 objects, and local uploads.');
    console.error(
      'Example: npm run dev:reset -- --confirm',
    );
    process.exit(1);
  }

  if (!options.skipDb && !databaseUrl) {
    throw new Error('DATABASE_URL must be set unless --skip-db is used.');
  }

  console.log('Starting destructive reset with target:');
  console.log(`- database: ${options.skipDb ? 'skip' : databaseUrl}`);
  console.log(`- bucket: ${options.skipBucket ? 'skip' : bucketName || '(missing)'}`);
  console.log(`- local uploads: ${options.skipLocalUploads ? 'skip' : path.join(process.cwd(), 'uploads')}`);

  if (!options.skipBucket) {
    const deletedCount = await emptyBucket(bucketName, region);
    console.log(`Emptied S3 bucket ${bucketName}. Deleted ${deletedCount} object(s).`);
  }

  if (!options.skipLocalUploads) {
    const localResult = removeLocalUploads();
    console.log(
      localResult.removed
        ? `Removed local uploads directory: ${localResult.path}`
        : `Local uploads directory not present: ${localResult.path}`,
    );
  }

  if (!options.skipDb) {
    resetDatabase();
    console.log('Database reset completed.');
    if (!options.skipSeed) {
      runSeed();
      verifySeededAdmin();
      console.log('Database seed completed and SuperAdmin verified.');
    } else {
      console.log('Database seed skipped.');
    }
  }

  console.log('Destructive reset complete.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
