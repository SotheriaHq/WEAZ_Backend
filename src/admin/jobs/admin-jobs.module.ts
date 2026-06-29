import { Module } from '@nestjs/common';
import { AdminJobsController } from './admin-jobs.controller';
import { CollectionsModule } from 'src/collections/collections.module';

@Module({
  imports: [CollectionsModule],
  controllers: [AdminJobsController],
})
export class AdminJobsModule {}
