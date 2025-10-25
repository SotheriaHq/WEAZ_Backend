import { Module } from '@nestjs/common';
import { ModerationController } from './moderation.controller';
import { PrismaService } from 'src/prisma/prisma.service';

@Module({
  controllers: [ModerationController],
  providers: [PrismaService],
})
export class ModerationModule {}

