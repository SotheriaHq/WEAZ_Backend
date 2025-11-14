import { Module, forwardRef } from '@nestjs/common';
import { CategoriesAdminController } from './categories.admin.controller';
import { CategoriesService } from './categories.service';
import { PrismaService } from '../prisma/prisma.service';
import { CategorySuggestionsService } from './suggestions/category-suggestions.service';
import { CategorySuggestionsController } from './suggestions/category-suggestions.controller';
import { CategorySuggestionsAdminController } from './suggestions/category-suggestions.admin.controller';
import { CollectionsModule } from '../collections/collections.module';

@Module({
  imports: [forwardRef(() => CollectionsModule)],
  controllers: [
    CategoriesAdminController,
    CategorySuggestionsController,
    CategorySuggestionsAdminController,
  ],
  providers: [CategoriesService, PrismaService, CategorySuggestionsService],
  exports: [CategoriesService, CategorySuggestionsService],
})
export class CategoriesModule {}
