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
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { UserTypeGuard } from 'src/auth/guard/user-type.guard';
import { MessagingService } from '../messaging.service';
import { MarkThreadReadDto, QueryMessagesDto, QueryThreadSummaryDto, SendMessageDto } from '../dto/messaging.dto';

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
}
