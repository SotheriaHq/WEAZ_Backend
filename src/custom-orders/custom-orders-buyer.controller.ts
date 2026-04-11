import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { UserType } from '@prisma/client';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { UserTypeGuard } from 'src/auth/guard/user-type.guard';
import { IdempotencyInterceptor } from 'src/common/interceptors/idempotency.interceptor';
import { CustomOrdersPaymentsService } from './custom-orders-payments.service';
import { CustomOrdersService } from './custom-orders.service';
import {
  ConfirmCustomOrderDeliveryDto,
  CreateCustomOrderDto,
  CustomOrderPricePreviewDto,
  InitializeCustomOrderPaymentDto,
  QueryCustomOrdersDto,
  ReportCustomOrderIssueDto,
  RespondToCustomOrderExtensionDto,
  UpdateCustomOrderMeasurementsDto,
  UpdateDisplayChartPreferenceDto,
  VerifyCustomOrderPaymentDto,
} from './dto/custom-orders.dto';

@Controller('custom-orders')
@UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.REGULAR))
export class CustomOrdersBuyerController {
  constructor(
    private readonly ordersService: CustomOrdersService,
    private readonly paymentsService: CustomOrdersPaymentsService,
  ) {}

  @Post('price-preview')
  async pricePreview(
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: CustomOrderPricePreviewDto,
  ) {
    return this.ordersService.createPricePreview(req.user.id, dto);
  }

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  async createOrder(
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: CreateCustomOrderDto,
  ) {
    return this.ordersService.createOrder(req.user.id, dto);
  }

  @Post('checkout/:id/payment/initialize')
  @UseInterceptors(IdempotencyInterceptor)
  async initializePaymentForCheckoutIntent(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: InitializeCustomOrderPaymentDto,
  ) {
    return this.paymentsService.initializePaymentForCheckoutIntent(req.user.id, id, dto);
  }

  @Post(':id/payment/initialize')
  @UseInterceptors(IdempotencyInterceptor)
  async initializePayment(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: InitializeCustomOrderPaymentDto,
  ) {
    return this.paymentsService.initializePayment(req.user.id, id, dto);
  }

  @Post('payment/verify')
  async verifyPaymentByReference(
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: VerifyCustomOrderPaymentDto,
  ) {
    return this.paymentsService.verifyPaymentByReference(req.user.id, dto);
  }

  @Post(':id/payment/verify')
  async verifyPayment(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: VerifyCustomOrderPaymentDto,
  ) {
    return this.paymentsService.verifyPayment(req.user.id, id, dto);
  }

  @Get()
  async listOrders(
    @Req() req: Request & { user: { id: string } },
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryCustomOrdersDto,
  ) {
    return this.ordersService.listBuyerOrders(req.user.id, query);
  }

  @Get('preferences/display-chart')
  async getDisplayChartPreference(
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.ordersService.getDisplayChartPreference(req.user.id);
  }

  @Post('preferences/display-chart')
  async updateDisplayChartPreference(
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: UpdateDisplayChartPreferenceDto,
  ) {
    return this.ordersService.updateDisplayChartPreference(req.user.id, dto);
  }

  @Get('checkout-sessions/resume/:token')
  async getCheckoutSessionByToken(
    @Param('token') token: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.ordersService.getCheckoutSessionByToken(req.user.id, token);
  }

  @Get('checkout-bag')
  async listCheckoutBagLines(
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.ordersService.listCheckoutBagLines(req.user.id);
  }

  @Post('checkout-sessions/:id/relock')
  async relockCheckoutBagLine(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.ordersService.relockCheckoutBagLine(req.user.id, id);
  }

  @Delete('checkout-sessions/:id')
  async removeCheckoutBagLine(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.ordersService.removeCheckoutBagLine(req.user.id, id);
  }

  @Get('checkout-sessions/:id')
  async getCheckoutSession(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.ordersService.getCheckoutSession(req.user.id, id);
  }

  @Get(':id')
  async getOrder(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.ordersService.getBuyerOrder(req.user.id, id);
  }

  @Get(':id/payment-attempts')
  async listPaymentAttempts(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.paymentsService.listBuyerPaymentAttempts(req.user.id, id);
  }

  @Post(':id/confirm-delivery')
  async confirmDelivery(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: ConfirmCustomOrderDeliveryDto,
  ) {
    return this.ordersService.confirmDelivery(req.user.id, id, dto);
  }

  @Post(':id/report-issue')
  async reportIssue(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: ReportCustomOrderIssueDto,
  ) {
    return this.ordersService.reportIssue(req.user.id, id, dto);
  }

  @Post(':id/update-measurements')
  async updateMeasurements(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: UpdateCustomOrderMeasurementsDto,
  ) {
    return this.ordersService.updateBuyerMeasurementsBeforeAcceptance(req.user.id, id, dto);
  }

  @Post(':id/extension-requests/:requestId/respond')
  async respondToExtension(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: RespondToCustomOrderExtensionDto,
  ) {
    return this.ordersService.respondToExtension(req.user.id, id, requestId, dto);
  }
}
