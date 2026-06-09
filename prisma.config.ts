import 'dotenv/config';
import { defineConfig } from 'prisma/config';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set before running Prisma.');
}

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
    url: process.env.DATABASE_URL,
  },
});
