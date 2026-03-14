import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { MeasurementPointsController } from './measurement-points.controller';
import { MeasurementPointsService } from './measurement-points.service';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [MeasurementPointsController],
  providers: [MeasurementPointsService],
  exports: [MeasurementPointsService],
})
export class MeasurementPointsModule {}
