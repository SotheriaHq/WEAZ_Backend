import {
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { UserType } from '@prisma/client';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { UserTypeGuard } from 'src/auth/guard/user-type.guard';
import { MessagingService } from '../messaging.service';
import { BulkQueryThreadSummaryDto } from '../dto/messaging.dto';

@Controller()
@UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.REGULAR))
export class MessagingSummaryBuyerController {
  constructor(private readonly messaging: MessagingService) {}

  @Post('custom-orders/messages/summaries')
  async customOrderSummaries(
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: BulkQueryThreadSummaryDto,
  ) {
    return this.messaging.getBulkSummariesForCustomOrdersBuyer(req.user.id, dto);
  }

  @Post(['orders/messages/summaries', 'store/orders/messages/summaries'])
  async orderSummaries(
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: BulkQueryThreadSummaryDto,
  ) {
    return this.messaging.getBulkSummariesForOrdersBuyer(req.user.id, dto);
  }
}
