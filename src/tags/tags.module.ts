import { Module } from '@nestjs/common';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemTagsService } from './system-tags.service';
import { TagIndexService } from './tag-index.service';
import { NotificationsModule } from 'src/notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [TagsController],
  providers: [TagsService, TagIndexService, SystemTagsService, PrismaService],
  exports: [TagsService, TagIndexService, SystemTagsService],
})
export class TagsModule {}
