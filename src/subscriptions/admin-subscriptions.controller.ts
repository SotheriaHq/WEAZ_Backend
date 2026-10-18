import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Roles } from '../auth/decorator/roles.decorator';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { RolesGuard } from '../auth/guard/role.guard';
import { ADMIN_PERMISSIONS } from '../admin/constants/permissions';
import { RequirePermissions } from '../admin/decorators/require-permissions.decorator';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import {
  SubscriptionAdminActor,
  SubscriptionsService,
} from './subscriptions.service';

class CompensationListDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}

class ReconcileCompensationDto {
  @IsOptional() @IsString() @Matches(/^\d{1,30}$/) providerRefundId?: string;
}

@Controller('admin/subscriptions/compensations')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminSubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  list(
    @Req() req: { user: SubscriptionAdminActor },
    @Query() query: CompensationListDto,
  ) {
    return this.subscriptions.listCompensations(
      req.user,
      query.cursor,
      query.limit,
    );
  }

  @Post(':captureId/reconcile')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  reconcile(
    @Req() req: { user: SubscriptionAdminActor },
    @Param('captureId', ParseUUIDPipe) captureId: string,
    @Body() dto: ReconcileCompensationDto,
  ) {
    return this.subscriptions.reconcileCompensation(
      req.user,
      captureId,
      dto.providerRefundId,
    );
  }
}
