import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { CustomOrdersService } from './custom-orders.service';
import {
  AcceptCustomOrderDto,
  BrandRespondToCustomOrderExtensionCounterDto,
  CreateExceptionReviewRequestDto,
  CreateCustomOrderExtensionRequestDto,
  QueryCustomOrdersDto,
  UpdateCustomOrderLifecycleStatusDto,
  UpdateCustomOrderProgressStageDto,
} from './dto/custom-orders.dto';

@Controller('brands/:brandId/custom-orders')
@UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
export class CustomOrdersBrandController {
  constructor(private readonly service: CustomOrdersService) {}

  @Get()
  async listOrders(
    @Param('brandId') brandId: string,
    @Req() req: Request & { user: { id: string } },
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryCustomOrdersDto,
  ) {
    return this.service.listBrandOrders(req.user.id, brandId, query);
  }

  @Get(':id')
  async getOrder(
    @Param('brandId') brandId: string,
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.service.getBrandOrder(req.user.id, brandId, id);
  }

  @Post(':id/accept')
  async acceptOrder(
    @Param('brandId') brandId: string,
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: AcceptCustomOrderDto,
  ) {
    return this.service.acceptBrandOrder(req.user.id, brandId, id, dto);
  }

  @Post(':id/progress-stage')
  async updateProgressStage(
    @Param('brandId') brandId: string,
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: UpdateCustomOrderProgressStageDto,
  ) {
    return this.service.updateBrandProgressStage(req.user.id, brandId, id, dto);
  }

  @Post(':id/extension-requests')
  async createExtensionRequest(
    @Param('brandId') brandId: string,
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: CreateCustomOrderExtensionRequestDto,
  ) {
    return this.service.createExtensionRequest(req.user.id, brandId, id, dto);
  }

  @Post(':id/extension-requests/:requestId/respond')
  async respondToBuyerCounter(
    @Param('brandId') brandId: string,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: BrandRespondToCustomOrderExtensionCounterDto,
  ) {
    return this.service.respondToBuyerCounter(req.user.id, brandId, id, requestId, dto);
  }

  @Patch(':id/status')
  async updateLifecycleStatus(
    @Param('brandId') brandId: string,
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: UpdateCustomOrderLifecycleStatusDto,
  ) {
    return this.service.updateLifecycleStatus(req.user.id, brandId, id, dto);
  }

  @Post(':id/exception-review-requests')
  async createExceptionReviewRequest(
    @Param('brandId') brandId: string,
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: CreateExceptionReviewRequestDto,
  ) {
    return this.service.createExceptionReviewRequest(req.user.id, brandId, id, dto);
  }
}
