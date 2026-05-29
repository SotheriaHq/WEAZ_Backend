import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { REVIEW_FEATURE_FLAGS } from './review.constants';

const REVIEW_FLAG_DEFINITIONS = [
  {
    key: REVIEW_FEATURE_FLAGS.READ,
    description: 'Controls public and compatibility read access for reviews.',
    defaultEnabled: false,
  },
  {
    key: REVIEW_FEATURE_FLAGS.WRITE,
    description:
      'Controls buyer review create, edit, delete, helpful votes, and reporting.',
    defaultEnabled: false,
  },
  {
    key: REVIEW_FEATURE_FLAGS.BRAND_REPLIES,
    description: 'Controls brand reply and brand review-report actions.',
    defaultEnabled: false,
  },
  {
    key: REVIEW_FEATURE_FLAGS.ADMIN_MODERATION,
    description: 'Controls admin review moderation and report queue access.',
    defaultEnabled: false,
  },
  {
    key: REVIEW_FEATURE_FLAGS.REMINDERS,
    description: 'Controls queued review reminder scheduling and delivery.',
    defaultEnabled: false,
  },
  {
    key: REVIEW_FEATURE_FLAGS.CAPTURE,
    description: 'Controls completed-order lifecycle review capture.',
    defaultEnabled: true,
  },
  {
    key: REVIEW_FEATURE_FLAGS.PROMPT_AFTER_COMPLETION,
    description:
      'Controls review prompt creation after completed standard and custom orders.',
    defaultEnabled: true,
  },
  {
    key: REVIEW_FEATURE_FLAGS.PUBLIC_PRODUCT,
    description: 'Controls public display of lifecycle product reviews.',
    defaultEnabled: true,
  },
  {
    key: REVIEW_FEATURE_FLAGS.PUBLIC_COLLECTION,
    description: 'Controls public display of lifecycle collection reviews.',
    defaultEnabled: false,
  },
  {
    key: REVIEW_FEATURE_FLAGS.PUBLIC_DESIGN,
    description: 'Controls public display of lifecycle design reviews.',
    defaultEnabled: false,
  },
  {
    key: REVIEW_FEATURE_FLAGS.PUBLIC_BRAND,
    description: 'Controls public display of lifecycle brand review summaries.',
    defaultEnabled: true,
  },
  {
    key: REVIEW_FEATURE_FLAGS.MODERATION_REQUIRED,
    description:
      'Controls whether lifecycle reviews require moderation before public display.',
    defaultEnabled: false,
  },
] as const;

@Injectable()
export class ReviewsFeatureFlagsBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(
    ReviewsFeatureFlagsBootstrapService.name,
  );

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await Promise.all(
      REVIEW_FLAG_DEFINITIONS.map((flag) =>
        this.prisma.featureFlag.upsert({
          where: { key: flag.key },
          update: {
            description: flag.description,
          },
          create: {
            id: crypto.randomUUID(),
            key: flag.key,
            description: flag.description,
            isEnabled: flag.defaultEnabled,
          },
        }),
      ),
    );

    this.logger.debug('Ensured review feature flags exist');
  }
}
