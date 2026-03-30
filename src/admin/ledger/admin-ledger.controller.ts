import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { LedgerTransactionType, Role } from '@prisma/client';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { AdminLedgerService } from './admin-ledger.service';

@Controller('admin/ledger')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminLedgerController {
  constructor(private readonly ledgerService: AdminLedgerService) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  list(
    @Query('type') type?: LedgerTransactionType,
    @Query('referenceType') referenceType?: string,
    @Query('referenceId') referenceId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ledgerService.list({
      type,
      referenceType,
      referenceId,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
