import { Module } from '@nestjs/common';
import { FollowsService } from './follows.service';
import { FollowsController } from './follows.controller';
import { PrismaService } from 'src/prisma/prisma.service';

@Module({
  imports: [],
  providers: [FollowsService, PrismaService],
  controllers: [FollowsController],
  exports: [FollowsService],
})
export class FollowsModule {}
