import {
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { CollectionSchedulerService } from 'src/collections/collection-scheduler.service';
import { ClockService } from 'src/common/clock/clock.service';

const isHardProduction =
  String(process.env.APP_ENV ?? '')
    .trim()
    .toLowerCase() === 'production';

/**
 * Non-production-only manual job triggers for QA / SIT / local testing.
 * All endpoints return 403 when APP_ENV=production.
 *
 * QA flow:
 *   1. Set CLOCK_MODE=offset CLOCK_OFFSET_DAYS=N in .env
 *   2. Restart API and worker
 *   3. POST /v1/admin/jobs/clock-state  — confirm effectiveNow is offset
 *   4. POST /v1/admin/jobs/run-collection-draft-expiry
 *   5. Inspect summary: draftsDeleted / warningsSent counts
 *   6. Reset CLOCK_MODE=real and restart
 */
@ApiTags('Admin Jobs (non-production)')
@Controller('v1/admin/jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SuperAdmin)
export class AdminJobsController {
  constructor(
    private readonly scheduler: CollectionSchedulerService,
    private readonly clock: ClockService,
  ) {}

  @Post('run-collection-draft-expiry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'NON-PROD ONLY: Manually trigger collection draft expiry cleanup',
    description:
      'Runs the same logic as the nightly draft cleanup cron. Returns a summary ' +
      'including effective clock state, warnings sent, and drafts deleted. ' +
      'Returns 403 in production (APP_ENV=production).',
  })
  async runCollectionDraftExpiry() {
    if (isHardProduction) {
      throw new ForbiddenException(
        'Manual job triggers are not available in production.',
      );
    }
    const summary = await this.scheduler.runDraftCleanup();
    return { triggered: true, summary };
  }

  @Post('clock-state')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'NON-PROD ONLY: Return current ClockService effective state',
    description:
      'Returns realNow, effectiveNow, mode, and offset/fixed details. ' +
      'Returns 403 in production (APP_ENV=production).',
  })
  clockState() {
    if (isHardProduction) {
      throw new ForbiddenException(
        'Clock state endpoint is not available in production.',
      );
    }
    return this.clock.getEffectiveState();
  }
}
