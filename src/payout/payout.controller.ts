import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { PayoutService } from './payout.service';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { BRAND_PERMISSIONS } from 'src/brands/permissions/brand-permissions';

@Controller('brands/:brandId/payouts')
@UseGuards(JwtAuthGuard)
export class PayoutController {
  constructor(
    private readonly payoutService: PayoutService,
    private readonly brandPermissionService: BrandPermissionService,
  ) {}

  @Get()
  async findAll(
    @Param('brandId') brandId: string,
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    await this.brandPermissionService.assertPermission(
      req.user.id,
      brandId,
      BRAND_PERMISSIONS.PAYOUTS_READ,
    );
    return this.payoutService.findAll(
      brandId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @Get('overview')
  async getOverview(
    @Param('brandId') brandId: string,
    @Req() req: any,
  ) {
    await this.brandPermissionService.assertPermission(
      req.user.id,
      brandId,
      BRAND_PERMISSIONS.PAYOUTS_READ,
    );
    return this.payoutService.getOverview(brandId);
  }

  @Get('incoming')
  async getIncomingTransactions(
    @Param('brandId') brandId: string,
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    await this.brandPermissionService.assertPermission(
      req.user.id,
      brandId,
      BRAND_PERMISSIONS.PAYOUTS_READ,
    );
    return this.payoutService.listIncomingTransactions(
      brandId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @Get('held-funds')
  async getHeldFunds(
    @Param('brandId') brandId: string,
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    await this.brandPermissionService.assertPermission(
      req.user.id,
      brandId,
      BRAND_PERMISSIONS.PAYOUTS_READ,
    );
    return this.payoutService.listHeldFunds(
      brandId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @Post('request')
  async requestPayout(
    @Param('brandId') brandId: string,
    @Body() body: { amount: number },
    @Req() req: any,
  ) {
    await this.payoutService.assertBrandOwnership(brandId, req.user.id);
    if (!body.amount || body.amount <= 0) {
      throw new BadRequestException('Invalid amount');
    }
    return this.payoutService.requestPayout(brandId, body.amount);
  }
}
