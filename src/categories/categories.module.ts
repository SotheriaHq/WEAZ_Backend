import { Module, forwardRef } from '@nestjs/common';
import { CategoriesAdminController } from './categories.admin.controller';
import { CategoriesPublicController } from './categories.public.controller';
import { CategoriesService } from './categories.service';
import { CategoriesBootstrapService } from './categories.bootstrap.service';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';
import { CollectionsModule } from 'src/collections/collections.module';
import { CategorySuggestionsAdminController } from './suggestions/category-suggestions.admin.controller';
import { CategorySuggestionsController } from './suggestions/category-suggestions.controller';
import { CategorySuggestionsService } from './suggestions/category-suggestions.service';

/**
 * `suggestions/` was written and never wired up.
 *
 * The controllers, the service and the DTOs all existed on disk with zero
 * references anywhere outside their own folder — so Nest never registered the
 * routes and every call fell through to the Express 404 handler. The admin
 * Taxonomy console surfaced that literally: "Cannot GET
 * /admin/categories/suggestions?status=PENDING" inside the Pending suggestions
 * tab. `POST /categories/suggestions` (a brand proposing a garment category)
 * and `GET /categories/suggestions/mine` were dead for the same reason.
 *
 * `forwardRef` on both sides because `CategorySuggestionsService` injects
 * `CollectionsService` (approving a suggestion re-points collections at the new
 * category) and the collections graph reaches back here.
 */
@Module({
  imports: [NotificationsModule, forwardRef(() => CollectionsModule)],
  controllers: [
    CategoriesAdminController,
    CategoriesPublicController,
    CategorySuggestionsAdminController,
    CategorySuggestionsController,
  ],
  providers: [
    CategoriesService,
    CategoriesBootstrapService,
    AdminAuditService,
    CategorySuggestionsService,
  ],
  exports: [CategoriesService, CategorySuggestionsService],
})
export class CategoriesModule {}
