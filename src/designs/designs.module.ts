import { Module } from '@nestjs/common';

import { CollectionsModule } from 'src/collections/collections.module';
import { CustomOrderConfigurationsModule } from 'src/custom-order-configurations/custom-order-configurations.module';
import { PrismaService } from 'src/prisma/prisma.service';
import { LegacyCollectionDesignAdapter } from './adapters/legacy-collection-design.adapter';
import { DesignResolverService } from './design-resolver.service';
import { DesignsController } from './designs.controller';
import { DesignsService } from './designs.service';

@Module({
  imports: [CollectionsModule, CustomOrderConfigurationsModule],
  controllers: [DesignsController],
  providers: [
    DesignsService,
    LegacyCollectionDesignAdapter,
    DesignResolverService,
    PrismaService,
  ],
  exports: [
    DesignsService,
    LegacyCollectionDesignAdapter,
    DesignResolverService,
  ],
})
export class DesignsModule {}
