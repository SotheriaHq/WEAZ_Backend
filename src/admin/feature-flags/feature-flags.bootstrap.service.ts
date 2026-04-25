import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const FEATURE_FLAG_DEFINITIONS = [
  {
    key: 'qr_codes_for_orders',
    description:
      'Controls whether order-level QR codes can be shown on buyer and brand order surfaces.',
  },
] as const;

@Injectable()
export class FeatureFlagsBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(FeatureFlagsBootstrapService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await Promise.all(
      FEATURE_FLAG_DEFINITIONS.map((flag) =>
        this.prisma.featureFlag.upsert({
          where: { key: flag.key },
          update: {
            description: flag.description,
          },
          create: {
            id: crypto.randomUUID(),
            key: flag.key,
            description: flag.description,
            isEnabled: false,
          },
        }),
      ),
    );

    this.logger.debug('Ensured admin feature flags exist');
  }
}
