import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ReadinessService } from './readiness.service';

@Controller()
export class ReadinessController {
  constructor(private readonly readinessService: ReadinessService) {}

  @Get('ready')
  async getReady(@Res({ passthrough: true }) res: Response) {
    const readiness = await this.readinessService.getReadiness();
    if (readiness.status !== 'ready') {
      res.status(503);
    }
    return readiness;
  }
}