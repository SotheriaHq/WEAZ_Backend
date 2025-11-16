import { Module } from '@nestjs/common';
import { BrandsService } from './brands.service';
import { BrandsController } from './brands.controller';
import { PrismaService } from '../prisma/prisma.service';
import { CollectionsModule } from '../collections/collections.module';

@Module({
  imports: [CollectionsModule],
  providers: [BrandsService, PrismaService],
  controllers: [BrandsController],
  exports: [BrandsService],
})
export class BrandsModule {}
