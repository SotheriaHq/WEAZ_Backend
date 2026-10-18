import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import {
  PreviewSubscriptionDto,
  SubscriptionCheckoutDto,
  VerifySubscriptionDto,
} from './subscription-checkout.dto';
import { SubscriptionsService } from './subscriptions.service';

@Controller('brands/:brandId/subscription')
@UseGuards(JwtAuthGuard)
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  get(
    @Param('brandId', ParseUUIDPipe) brandId: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.subscriptions.getForOwner(req.user.id, brandId);
  }

  @Post('checkout')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  checkout(
    @Param('brandId', ParseUUIDPipe) brandId: string,
    @Req() req: Request & { user: { id: string } },
    @Body() dto: SubscriptionCheckoutDto,
  ) {
    return this.subscriptions.checkout(req.user.id, brandId, dto, req);
  }

  @Post('preview')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  preview(
    @Param('brandId', ParseUUIDPipe) brandId: string,
    @Req() req: Request & { user: { id: string } },
    @Body() dto: PreviewSubscriptionDto,
  ) {
    return this.subscriptions.previewForOwner(
      req.user.id,
      brandId,
      dto.tierKey,
    );
  }

  @Post('verify')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  verify(
    @Param('brandId', ParseUUIDPipe) brandId: string,
    @Req() req: Request & { user: { id: string } },
    @Body() dto: VerifySubscriptionDto,
  ) {
    return this.subscriptions.verifyForOwner(
      req.user.id,
      brandId,
      dto.reference,
    );
  }

  @Post('cancel-renewal')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  cancel(
    @Param('brandId', ParseUUIDPipe) brandId: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.subscriptions.cancelRenewal(req.user.id, brandId);
  }
}
