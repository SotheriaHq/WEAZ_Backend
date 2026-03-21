import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { SystemConfigService } from './system-config.service';
import { PublicConfigController } from './public-config.controller';

/**
 * Standalone module for SystemConfigService.
 * Import this wherever you need to read config values (e.g. upload limits).
 * The admin controller is registered in AdminModule separately.
 */
@Module({
  imports: [PrismaModule],
  controllers: [PublicConfigController],
  providers: [SystemConfigService],
  exports: [SystemConfigService],
})
export class SystemConfigModule {}
