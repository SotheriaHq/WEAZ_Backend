import { Module } from '@nestjs/common';
import { CategoriesAdminController } from './categories.admin.controller';
import { CategoriesPublicController } from './categories.public.controller';
import { CategoriesService } from './categories.service';
import { PrismaService } from '../prisma/prisma.service';
import { CategoriesBootstrapService } from './categories.bootstrap.service';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';

@Module({
  imports: [NotificationsModule],
  controllers: [CategoriesAdminController, CategoriesPublicController],
  providers: [
    CategoriesService,
    PrismaService,
    CategoriesBootstrapService,
    AdminAuditService,
  ],
  exports: [CategoriesService],
})
export class CategoriesModule {}
