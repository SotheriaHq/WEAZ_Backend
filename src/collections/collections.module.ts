import { Module } from '@nestjs/common';
import { CollectionsService } from './collections.service';
import { CollectionsController } from './collections.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadModule } from 'src/upload/upload.module';
import { HelperService } from './helper/Helper.service';

@Module({
  imports: [UploadModule],
  providers: [CollectionsService, PrismaService, HelperService],
  controllers: [CollectionsController],
  exports: [CollectionsService],
})
export class CollectionsModule {}
