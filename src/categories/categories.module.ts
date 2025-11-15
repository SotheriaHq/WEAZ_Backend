import { Module } from '@nestjs/common';
import { CategoriesAdminController } from './categories.admin.controller';
import { CategoriesService } from './categories.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  imports: [],
  controllers: [CategoriesAdminController],
  providers: [CategoriesService, PrismaService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
