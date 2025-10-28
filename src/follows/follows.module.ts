import { Module } from '@nestjs/common';
import { FollowsService } from './follows.service';
import { FollowsController } from './follows.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsModule } from 'src/notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  providers: [FollowsService, PrismaService],
  controllers: [FollowsController],
  exports: [FollowsService],
})
export class FollowsModule {}
