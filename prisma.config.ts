import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// NOTE: DATABASE_URL is intentionally NOT required here.
// `prisma generate` only reads the schema and must succeed at build time
// (e.g. inside a Docker image or CI) where no live database URL exists.
// The runtime DB connection is handled by PrismaService via
// process.env.DATABASE_URL (see src/prisma/prisma.service.ts), which has its
// own guard. CLI commands that actually hit the DB (migrate/seed) will fail
// naturally if DATABASE_URL is unset.
const PLACEHOLDER_DATABASE_URL =
  'postgresql://placeholder:placeholder@localhost:5432/placeholder';

const skipConfiguredSeed = process.env.THREADLY_PRISMA_SKIP_SEED === 'true';

export default defineConfig({
  schema: './prisma/schema.prisma',
  ...(skipConfiguredSeed
    ? {}
    : {
        migrations: {
          seed: 'npm run prisma:seed',
        },
      }),
  datasource: {
    url: process.env.DATABASE_URL ?? PLACEHOLDER_DATABASE_URL,
  },
});
