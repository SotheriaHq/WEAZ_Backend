import { Module } from '@nestjs/common';
import { ModerationController } from './moderation.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [ModerationController],
  providers: [PrismaService],
})
export class ModerationModule {}
