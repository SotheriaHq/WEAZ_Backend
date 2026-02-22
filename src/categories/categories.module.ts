import { Module } from '@nestjs/common';
import { CategoriesAdminController } from './categories.admin.controller';
import { CategoriesPublicController } from './categories.public.controller';
import { CategoriesService } from './categories.service';
import { PrismaService } from '../prisma/prisma.service';
import { CategoriesBootstrapService } from './categories.bootstrap.service';

@Module({
  imports: [],
  controllers: [CategoriesAdminController, CategoriesPublicController],
  providers: [CategoriesService, PrismaService, CategoriesBootstrapService],
  exports: [CategoriesService],
})
export class CategoriesModule { }
