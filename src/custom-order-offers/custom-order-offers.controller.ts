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
import { CustomOrderOffersService } from './custom-order-offers.service';
import {
  CreateCustomFabricRuleBasisDto,
  CreateCustomOrderOfferDto,
  QueryCustomFabricRuleBasesDto,
  QueryCustomOrderOffersDto,
  UpdateCustomOrderOfferDto,
} from './dto/custom-order-offers.dto';

@Controller()
export class CustomOrderOffersController {
  constructor(private readonly service: CustomOrderOffersService) {}

  @Get('custom-order-offers')
  @UseGuards(OptionalJwtAuthGuard)
  async listVisibleOffers(
    @Req() req: Request & { user?: { id?: string } },
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryCustomOrderOffersDto,
  ) {
    return this.service.listVisibleOffers(req.user?.id, query);
  }

  @Post('custom-order-offers')
  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  async createOffer(
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: CreateCustomOrderOfferDto,
  ) {
    return this.service.createOffer(req.user.id, dto);
  }

  @Patch('custom-order-offers/:id')
  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  async updateOffer(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: UpdateCustomOrderOfferDto,
  ) {
    return this.service.updateOffer(req.user.id, id, dto);
  }

  @Get('custom-order-offers/:id')
  @UseGuards(OptionalJwtAuthGuard)
  async getOffer(
    @Param('id') id: string,
    @Req() req: Request & { user?: { id?: string } },
  ) {
    return this.service.getOffer(id, req.user?.id);
  }

  @Get('brands/:brandId/custom-order-offers')
  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  async listBrandOffers(
    @Param('brandId') brandId: string,
    @Req() req: Request & { user: { id: string } },
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryCustomOrderOffersDto,
  ) {
    return this.service.listBrandOffers(req.user.id, brandId, query);
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
