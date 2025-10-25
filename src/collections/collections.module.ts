import { Module } from '@nestjs/common';
import { CollectionsService } from './collections.service';
import { CollectionsController } from './collections.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadModule } from 'src/upload/upload.module';
import { HelperService } from './helper/Helper.service';
import { AnalyticsModule } from 'src/analytics/analytics.module';
import { EventsGateway } from 'src/realtime/events.gateway';

@Module({
  imports: [UploadModule, AnalyticsModule],
  providers: [CollectionsService, PrismaService, HelperService, EventsGateway],
  controllers: [CollectionsController],
  exports: [CollectionsService],
})
export class CollectionsModule {}
