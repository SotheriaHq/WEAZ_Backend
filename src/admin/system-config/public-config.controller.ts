import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SystemConfigService } from './system-config.service';

@ApiTags('config')
@Controller('config')
export class PublicConfigController {
  constructor(private readonly configService: SystemConfigService) {}

  @Get('upload-limits')
  @ApiOperation({ summary: 'Get upload size limits (public, for UI display)' })
  async getUploadLimits() {
    return this.configService.getUploadLimits();
  }
}
