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
  OpenCustomOrderDisputeDto,
  QueryMessagesDto,
  QueryThreadSummaryDto,
  RespondCustomOrderExtensionDto,
  SendMessageDto,
  UpdateThreadPreferencesDto,
} from '../dto/messaging.dto';

@Controller('custom-orders/:orderId/messages')
@UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.REGULAR))
export class CustomOrderMessagingBuyerController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  async listMessages(
    @Req() req: Request & { user: { id: string } },
    @Param('orderId') orderId: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryMessagesDto,
  ) {
    return this.messaging.listCustomOrderMessagesForBuyer(req.user.id, orderId, query);
  }

  @Post()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async sendMessage(
    @Req() req: Request & { user: { id: string } },
    @Param('orderId') orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-idempotency-key') legacyIdempotencyKey: string | undefined,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: SendMessageDto,
  ) {
    return this.messaging.sendCustomOrderMessageForBuyer(
      req.user.id,
      orderId,
      dto,
      idempotencyKey ?? legacyIdempotencyKey,
    );
  }

  @Post('read')
  async markRead(
    @Req() req: Request & { user: { id: string } },
    @Param('orderId') orderId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: MarkThreadReadDto,
  ) {
    return this.messaging.markThreadReadForContext(
      req.user.id,
      'CUSTOM_ORDER',
      orderId,
      'BUYER',
      dto,
    );
  }

  @Post('preferences')
  async updatePreferences(
    @Req() req: Request & { user: { id: string } },
    @Param('orderId') orderId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: UpdateThreadPreferencesDto,
  ) {
    return this.messaging.updateThreadPreferencesForContext(
      req.user.id,
      'CUSTOM_ORDER',
      orderId,
      'BUYER',
      dto,
    );
  }

  @Get('summary')
  async summary(
    @Req() req: Request & { user: { id: string } },
    @Param('orderId') orderId: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryThreadSummaryDto,
  ) {
    return this.messaging.getSummaryForContext(
      req.user.id,
      'CUSTOM_ORDER',
      orderId,
      'BUYER',
      query,
    );
  }

  @Post('extension-requests/:requestId/respond')
  async respondToExtension(
    @Req() req: Request & { user: { id: string } },
    @Param('orderId') orderId: string,
    @Param('requestId') requestId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: RespondCustomOrderExtensionDto,
  ) {
    return this.messaging.respondToCustomOrderExtensionForBuyer(req.user.id, orderId, requestId, dto);
  }

  @Post('disputes')
  async openDispute(
    @Req() req: Request & { user: { id: string } },
    @Param('orderId') orderId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: OpenCustomOrderDisputeDto,
  ) {
    return this.messaging.openCustomOrderDisputeForBuyer(req.user.id, orderId, dto);
  }
}
