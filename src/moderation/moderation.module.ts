import { Module } from '@nestjs/common';
import { ModerationController } from './moderation.controller';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [ModerationController],
})
export class ModerationModule {}
