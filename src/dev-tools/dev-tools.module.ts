import { Module } from '@nestjs/common';
import { DevToolsController } from './dev-tools.controller';
import { DevToolsService } from './dev-tools.service';

@Module({
  controllers: [DevToolsController],
  providers: [DevToolsService],
})
export class DevToolsModule {}
