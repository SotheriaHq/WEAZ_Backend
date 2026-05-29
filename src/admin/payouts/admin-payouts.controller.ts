import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { Role, PayoutStatus } from '@prisma/client';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { AdminPayoutsService } from './admin-payouts.service';
import { Request } from 'express';
import { ADMIN_PERMISSIONS } from '../constants/permissions';

@Controller('admin/payouts')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminPayoutsController {
  constructor(private readonly payoutsService: AdminPayoutsService) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  list(
    @Query('status') status?: PayoutStatus,
    @Query('brandId') brandId?: string,
    @Query('cursor') cursor?: string,
    @Query('take') take?: string,
  ) {
    return this.payoutsService.list({
      status,
      brandId,
      cursor,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  getById(@Param('id') id: string) {
    return this.payoutsService.getById(id);
  }

  @Patch(':id/status')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  updateStatus(
    @Param('id') id: string,
    @Body() dto: { status: PayoutStatus; reason?: string },
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    const actorRole = (req as any).user.role as Role;
    return this.payoutsService.updateStatus(id, dto, actorId, actorRole, req);
  }

  @Post(':id/claim')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  claim(@Param('id') id: string, @Req() req: Request) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    const actorRole = (req as any).user.role as Role;
    return this.payoutsService.claim(id, actorId, actorRole, req);
  }

  @Post(':id/release')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  release(
    @Param('id') id: string,
    @Body() dto: { reason?: string },
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    const actorRole = (req as any).user.role as Role;
    return this.payoutsService.release(
      id,
      actorId,
      actorRole,
      req,
      dto?.reason,
    );
  }

  @Post(':id/initiate-transfer')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  initiateTransfer(@Param('id') id: string, @Req() req: Request) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    const actorRole = (req as any).user.role as Role;
    return this.payoutsService.initiateTransfer(id, actorId, actorRole, req);
  }

  @Post(':id/finalize-transfer-otp')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  finalizeTransferOtp(
    @Param('id') id: string,
    @Body() dto: { otp: string },
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    const actorRole = (req as any).user.role as Role;
    return this.payoutsService.finalizeTransferOtp(
      id,
      dto?.otp,
      actorId,
      actorRole,
      req,
    );
  }

  @Get(':id/provider-status')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  getProviderStatus(@Param('id') id: string, @Req() req: Request) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    const actorRole = (req as any).user.role as Role;
    return this.payoutsService.getProviderStatus(id, actorId, actorRole);
  }
}
