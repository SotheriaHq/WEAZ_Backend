import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppService } from './app.service';
import { ReadinessService } from './health/readiness.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly readinessService: ReadinessService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('healthz')
  getHealth() {
    return this.appService.getHealth();
  }

  @Get('ready')
  async getReady(@Res({ passthrough: true }) res: Response) {
    const readiness = await this.readinessService.getReadiness();
    if (readiness.status !== 'ready') {
      res.status(503);
    }
    return readiness;
  }
}