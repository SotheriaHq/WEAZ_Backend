import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { REVIEW_FEATURE_FLAGS } from './review.constants';

const REVIEW_FLAG_DEFINITIONS = [
    {
        key: REVIEW_FEATURE_FLAGS.READ,
        description: 'Controls public and compatibility read access for reviews.',
    },
    {
        key: REVIEW_FEATURE_FLAGS.WRITE,
        description: 'Controls buyer review create, edit, delete, helpful votes, and reporting.',
    },
    {
        key: REVIEW_FEATURE_FLAGS.BRAND_REPLIES,
        description: 'Controls brand reply and brand review-report actions.',
    },
    {
        key: REVIEW_FEATURE_FLAGS.ADMIN_MODERATION,
        description: 'Controls admin review moderation and report queue access.',
    },
    {
        key: REVIEW_FEATURE_FLAGS.REMINDERS,
        description: 'Controls queued review reminder scheduling and delivery.',
    },
] as const;

@Injectable()
export class ReviewsFeatureFlagsBootstrapService implements OnModuleInit {
    private readonly logger = new Logger(ReviewsFeatureFlagsBootstrapService.name);

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
                        isEnabled: false,
                    },
                }),
            ),
        );

        this.logger.debug('Ensured review feature flags exist');
    }
}
