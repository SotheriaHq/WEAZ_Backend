import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { FeatureFlagsService } from './feature-flags.service';
import { Request } from 'express';

@ApiTags('admin/feature-flags')
@ApiBearerAuth()
@Controller('admin/feature-flags')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SuperAdmin)
export class FeatureFlagsController {
  constructor(private readonly service: FeatureFlagsService) {}

  @Get()
  @ApiOperation({ summary: 'List all feature flags' })
  async list() {
    return this.service.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a feature flag' })
  async create(
    @Body() dto: { key: string; description?: string; isEnabled?: boolean },
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.service.create(dto, req.user.id, req);
  }

  @Patch(':id/toggle')
  @ApiOperation({ summary: 'Toggle a feature flag' })
  async toggle(
    @Param('id') id: string,
    @Body('isEnabled') isEnabled: boolean,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.service.toggle(id, isEnabled, req.user.id, req);
  }
}
