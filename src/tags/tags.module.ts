import { Module } from '@nestjs/common';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';
import { SystemTagsService } from './system-tags.service';
import { TagIndexService } from './tag-index.service';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';

@Module({
  imports: [NotificationsModule],
  controllers: [TagsController],
  providers: [
    TagsService,
    TagIndexService,
    SystemTagsService,
    AdminAuditService,
  ],
  exports: [TagsService, TagIndexService, SystemTagsService],
})
export class TagsModule {}
