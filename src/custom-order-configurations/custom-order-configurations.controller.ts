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
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import { UserTypeGuard } from 'src/auth/guard/user-type.guard';
import { Request } from 'express';
import { CustomOrderConfigurationsService } from './custom-order-configurations.service';
import {
  CreateCustomFabricRuleBasisDto,
  CreateCustomOrderConfigurationDto,
  QueryCustomFabricRuleBasesDto,
  QueryVisibleCustomOrderConfigurationsDto,
  UpdateCustomOrderConfigurationDto,
} from './dto/custom-order-configurations.dto';
import { CustomOrderSourceType } from '@prisma/client';

@Controller()
export class CustomOrderConfigurationsController {
  constructor(private readonly service: CustomOrderConfigurationsService) {}

  @Get('products/:productId/custom-order-configuration')
  @UseGuards(OptionalJwtAuthGuard)
  async getActiveProductConfiguration(
    @Param('productId') productId: string,
    @Req() req: Request & { user?: { id?: string } },
  ) {
    return this.service.getActiveConfigurationForSource(
      CustomOrderSourceType.PRODUCT,
      productId,
      req.user?.id,
    );
  }

  // Route ownership moved to DesignsController. Keep custom-order business
  // behavior in CustomOrderConfigurationsService so the endpoint response stays
  // compatible while /designs owns design-facing routes.
  async getActiveDesignConfiguration(
    @Param('designId') designId: string,
    @Req() req: Request & { user?: { id?: string } },
  ) {
    return this.service.getActiveConfigurationForSource(
      CustomOrderSourceType.DESIGN,
      designId,
      req.user?.id,
    );
  }

  @Get('custom-order-configurations')
  @UseGuards(OptionalJwtAuthGuard)
  async listVisibleConfigurations(
    @Req() req: Request & { user?: { id?: string } },
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryVisibleCustomOrderConfigurationsDto,
  ) {
    return this.service.listVisibleConfigurations(req.user?.id, query);
  }

  @Post('custom-order-configurations')
  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  async createConfiguration(
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: CreateCustomOrderConfigurationDto,
  ) {
    return this.service.createConfiguration(req.user.id, dto);
  }

  @Patch('custom-order-configurations/:id')
  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  async updateConfiguration(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: UpdateCustomOrderConfigurationDto,
  ) {
    return this.service.updateConfiguration(req.user.id, id, dto);
  }

  @Get('custom-order-configurations/:id')
  @UseGuards(OptionalJwtAuthGuard)
  async getConfiguration(
    @Param('id') id: string,
    @Req() req: Request & { user?: { id?: string } },
  ) {
    return this.service.getConfiguration(id, req.user?.id);
  }

  @Post('custom-fabric-rule-bases')
  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  async createBasis(
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: CreateCustomFabricRuleBasisDto,
  ) {
    return this.service.createBasis(req.user.id, dto);
  }

  @Get('custom-fabric-rule-bases')
  @UseGuards(OptionalJwtAuthGuard)
  async listBases(
    @Req() req: Request & { user?: { id?: string } },
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryCustomFabricRuleBasesDto,
  ) {
    return this.service.listBases(req.user?.id, query);
  }
}
