import {
  Body,
  Controller,
  Get,
  Param,
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
import { CreateFreeformPointDto } from './dto/create-freeform-point.dto';
import { QueryMeasurementPointsDto } from './dto/query-measurement-points.dto';
import { MeasurementPointsService } from './measurement-points.service';

@Controller('measurement-points')
export class MeasurementPointsController {
  constructor(
    private readonly measurementPointsService: MeasurementPointsService,
  ) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  async getAll(
    @Req() req: any,
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: QueryMeasurementPointsDto,
  ) {
    return this.measurementPointsService.getAll(
      query,
      req.user?.id,
      req.user?.type,
    );
  }

  @Get('brand/:brandId')
  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  async getForBrand(@Req() req: any, @Param('brandId') brandId: string) {
    return this.measurementPointsService.getForBrand(req.user.id, brandId);
  }

  @Post('freeform')
  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  async createFreeform(
    @Req() req: any,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: CreateFreeformPointDto,
  ) {
    return this.measurementPointsService.submitFreeform(req.user.id, dto);
  }
}
