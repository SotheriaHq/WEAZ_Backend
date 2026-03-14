import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { UserType } from '@prisma/client';
import { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { UserTypeGuard } from 'src/auth/guard/user-type.guard';
import { MessagingService } from '../messaging.service';
import { MarkThreadReadDto, QueryMessagesDto, QueryThreadSummaryDto, SendMessageDto } from '../dto/messaging.dto';

@Controller('brands/:brandId/orders/:orderId/messages')
@UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
export class OrderMessagingBrandController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  async listMessages(
    @Req() req: Request & { user: { id: string } },
    @Param('brandId') brandId: string,
    @Param('orderId') orderId: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryMessagesDto,
  ) {
    return this.messaging.listOrderMessagesForBrand(req.user.id, brandId, orderId, query);
  }

  @Post()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async sendMessage(
    @Req() req: Request & { user: { id: string } },
    @Param('brandId') brandId: string,
    @Param('orderId') orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-idempotency-key') legacyIdempotencyKey: string | undefined,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: SendMessageDto,
  ) {
    return this.messaging.sendOrderMessageForBrand(
      req.user.id,
      brandId,
      orderId,
      dto,
      idempotencyKey ?? legacyIdempotencyKey,
    );
  }

  @Post('read')
  async markRead(
    @Req() req: Request & { user: { id: string } },
    @Param('brandId') brandId: string,
    @Param('orderId') orderId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: MarkThreadReadDto,
  ) {
    return this.messaging.markThreadReadForContext(
      req.user.id,
      'STANDARD_ORDER',
      orderId,
      'BRAND_OWNER',
      dto,
      brandId,
    );
  }

  @Get('summary')
  async summary(
    @Req() req: Request & { user: { id: string } },
    @Param('brandId') brandId: string,
    @Param('orderId') orderId: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryThreadSummaryDto,
  ) {
    return this.messaging.getSummaryForContext(
      req.user.id,
      'STANDARD_ORDER',
      orderId,
      'BRAND_OWNER',
      query,
      brandId,
    );
  }
}
