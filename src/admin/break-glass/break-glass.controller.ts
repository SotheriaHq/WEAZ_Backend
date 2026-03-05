import { Controller, Post, Body, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BreakGlassService } from './break-glass.service';
import { Request } from 'express';

@ApiTags('admin/break-glass')
@Controller('admin/break-glass')
export class BreakGlassController {
  constructor(private readonly service: BreakGlassService) {}

  @Post()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Emergency break-glass access (no auth required)' })
  async attempt(
    @Body('code') code: string,
    @Req() req: Request,
  ) {
    return this.service.attempt(code, req);
  }
}
