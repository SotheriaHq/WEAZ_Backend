import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { FeaturedController } from './featured.controller';
import { AdminFeaturedService } from '../admin/featured/admin-featured.service';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [FeaturedController],
  providers: [AdminFeaturedService],
})
export class FeaturedModule {}
