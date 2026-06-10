import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { seedMeasurementPoints } from './seed_measurement_points';

const datasourceUrl = process.env.DATABASE_URL;

if (!datasourceUrl) {
  throw new Error('DATABASE_URL must be set to seed measurement points.');
}

const pool = new Pool({ connectionString: datasourceUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function countActiveSystemMeasurementPoints() {
  return (prisma as any).measurementPoint.count({
    where: {
      source: 'SYSTEM',
      status: 'APPROVED_GLOBAL',
      isActive: true,
    },
  });
}

async function main() {
  const beforeCount = await countActiveSystemMeasurementPoints();
  await seedMeasurementPoints(prisma);
  const afterCount = await countActiveSystemMeasurementPoints();

  console.log(
    `Active system measurement points: before=${beforeCount} after=${afterCount}`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    await pool.end();
    process.exit(1);
  });
