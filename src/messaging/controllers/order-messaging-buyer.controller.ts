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
import {
  MarkThreadReadDto,
  OpenOrderDisputeDto,
  QueryMessagesDto,
  QueryThreadSummaryDto,
  RespondOrderExtensionDto,
  SendMessageDto,
  UpdateThreadPreferencesDto,
} from '../dto/messaging.dto';

@Controller()
@UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.REGULAR))
export class OrderMessagingBuyerController {
  constructor(private readonly messaging: MessagingService) {}

  @Get(['orders/:orderId/messages', 'store/orders/:orderId/messages'])
  async listMessages(
    @Req() req: Request & { user: { id: string } },
    @Param('orderId') orderId: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryMessagesDto,
  ) {
    return this.messaging.listOrderMessagesForBuyer(req.user.id, orderId, query);
  }

  @Post(['orders/:orderId/messages', 'store/orders/:orderId/messages'])
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async sendMessage(
    @Req() req: Request & { user: { id: string } },
    @Param('orderId') orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-idempotency-key') legacyIdempotencyKey: string | undefined,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: SendMessageDto,
  ) {
    return this.messaging.sendOrderMessageForBuyer(
      req.user.id,
      orderId,
      dto,
      idempotencyKey ?? legacyIdempotencyKey,
    );
  }

  @Post(['orders/:orderId/messages/read', 'store/orders/:orderId/messages/read'])
  async markRead(
    @Req() req: Request & { user: { id: string } },
    @Param('orderId') orderId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: MarkThreadReadDto,
  ) {
    return this.messaging.markThreadReadForContext(
      req.user.id,
      'STANDARD_ORDER',
      orderId,
      'BUYER',
      dto,
    );
  }

  @Post(['orders/:orderId/messages/preferences', 'store/orders/:orderId/messages/preferences'])
  async updatePreferences(
    @Req() req: Request & { user: { id: string } },
    @Param('orderId') orderId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: UpdateThreadPreferencesDto,
  ) {
    return this.messaging.updateThreadPreferencesForContext(
      req.user.id,
      'STANDARD_ORDER',
      orderId,
      'BUYER',
      dto,
    );
  }

  @Get(['orders/:orderId/messages/summary', 'store/orders/:orderId/messages/summary'])
  async summary(
    @Req() req: Request & { user: { id: string } },
    @Param('orderId') orderId: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryThreadSummaryDto,
  ) {
    return this.messaging.getSummaryForContext(
      req.user.id,
      'STANDARD_ORDER',
      orderId,
      'BUYER',
      query,
    );
  }

  @Post(['orders/:orderId/messages/extension-requests/:requestMessageId/respond', 'store/orders/:orderId/messages/extension-requests/:requestMessageId/respond'])
  async respondToExtension(
    @Req() req: Request & { user: { id: string } },
    @Param('orderId') orderId: string,
    @Param('requestMessageId') requestMessageId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: RespondOrderExtensionDto,
  ) {
    return this.messaging.respondToOrderExtensionForBuyer(req.user.id, orderId, requestMessageId, dto);
  }

  @Post(['orders/:orderId/messages/disputes', 'store/orders/:orderId/messages/disputes'])
  async openDispute(
    @Req() req: Request & { user: { id: string } },
    @Param('orderId') orderId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: OpenOrderDisputeDto,
  ) {
    return this.messaging.openOrderDisputeForBuyer(req.user.id, orderId, dto);
  }
}
