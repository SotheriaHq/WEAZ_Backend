import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { MessagingService } from '../messaging.service';
import { BulkQueryThreadSummaryDto } from '../dto/messaging.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class MessagingSummaryBrandController {
  constructor(private readonly messaging: MessagingService) {}

  @Post('brands/:brandId/custom-orders/messages/summaries')
  async customOrderSummaries(
    @Req() req: Request & { user: { id: string } },
    @Param('brandId') brandId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: BulkQueryThreadSummaryDto,
  ) {
    return this.messaging.getBulkSummariesForCustomOrdersBrand(req.user.id, brandId, dto);
  }

  @Post('brands/:brandId/orders/messages/summaries')
  async orderSummaries(
    @Req() req: Request & { user: { id: string } },
    @Param('brandId') brandId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: BulkQueryThreadSummaryDto,
  ) {
    return this.messaging.getBulkSummariesForOrdersBrand(req.user.id, brandId, dto);
  }
}
