import { Controller, Get, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AppService } from './app.service';
import { ReadinessService } from './health/readiness.service';
import { IsPublic } from './auth/decorator/is-public.decorator';

// Root + health/readiness probes must be reachable without auth.
@IsPublic()
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

  // Liveness does no I/O, and it must not report the process as dead because
  // the rate-limit store is unreachable. /ready is what reports Redis.
  @SkipThrottle()
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
