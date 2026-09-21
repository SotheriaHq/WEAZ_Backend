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
import { Throttle } from '@nestjs/throttler';
import { PayoutService } from './payout.service';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { BRAND_PERMISSIONS } from 'src/brands/permissions/brand-permissions';

@Controller('brands/:brandId/payouts')
@UseGuards(JwtAuthGuard)
@Throttle({ default: { limit: 40, ttl: 60000 } })
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
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async getOverview(@Param('brandId') brandId: string, @Req() req: any) {
    await this.brandPermissionService.assertPermission(
      req.user.id,
      brandId,
      BRAND_PERMISSIONS.PAYOUTS_READ,
    );
    return this.payoutService.getOverview(brandId);
  }

  @Get('incoming')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
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
  @Throttle({ default: { limit: 30, ttl: 60000 } })
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

  /**
   * Starts a payout. Creates NOTHING — it validates and emails a code.
   *
   * The response is a challenge (`challengeRequired: true`), and the payout
   * exists only once `request/confirm` spends that code.
   */
  @Post('request')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async requestPayout(
    @Param('brandId') brandId: string,
    @Body() body: { amount: number },
    @Req() req: any,
  ) {
    await this.payoutService.assertBrandOwnership(brandId, req.user.id);
    if (!body.amount || body.amount <= 0) {
      throw new BadRequestException('Invalid amount');
    }
    return this.payoutService.requestPayout(brandId, body.amount, req.user.id);
  }

  /**
   * Spends the emailed code and creates the payout.
   *
   * Tighter than the request throttle on purpose: this is the endpoint a
   * six-digit code can be guessed against. The per-code attempt budget is the
   * real defence — five wrong tries burns it — and this caps how fast an
   * attacker can cycle through fresh codes to widen that budget.
   *
   * No amount is accepted here. It comes from the code.
   */
  @Post('request/confirm')
  @Throttle({ default: { limit: 10, ttl: 300000 } })
  async confirmPayoutRequest(
    @Param('brandId') brandId: string,
    @Body() body: { code: string },
    @Req() req: any,
  ) {
    await this.payoutService.assertBrandOwnership(brandId, req.user.id);
    const code = String(body?.code ?? '').trim();
    if (!code) {
      throw new BadRequestException('Enter the code we emailed you.');
    }
    return this.payoutService.confirmPayoutRequest(brandId, code, req.user.id);
  }
}
