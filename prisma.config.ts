import 'dotenv/config';
import { defineConfig } from 'prisma/config';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set before running Prisma.');
}

export default defineConfig({
  schema: './prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
