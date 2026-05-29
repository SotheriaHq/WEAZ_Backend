import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { BagCountPresenter } from './bag-count.presenter';
import { BagEligibilityService } from './bag-eligibility.service';
import { CollectionBaggingService } from './collection-bagging.service';
import {
  BagCollectionAllDto,
  BagCollectionSelectedDto,
} from './dto/collection-bagging.dto';

@Controller('bag')
export class BaggingController {
  constructor(
    private readonly eligibilityService: BagEligibilityService,
    private readonly countPresenter: BagCountPresenter,
    private readonly collectionBaggingService: CollectionBaggingService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('count')
  async getBagCount(@Req() req: any) {
    return this.countPresenter.getCount(req.user.id);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('sources/:sourceType/:sourceId/status')
  async getSourceBagStatus(
    @Param('sourceType') sourceType: string,
    @Param('sourceId') sourceId: string,
    @Req() req: any,
  ) {
    return this.eligibilityService.getSourceBagStatus(
      sourceType,
      sourceId,
      req.user?.id,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('collections/:collectionId/bag-all')
  async bagCollectionAll(
    @Param('collectionId') collectionId: string,
    @Req() req: any,
    @Body() body: BagCollectionAllDto,
  ) {
    return this.collectionBaggingService.bagAll(
      collectionId,
      req.user.id,
      body ?? {},
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('collections/:collectionId/bag-selected')
  async bagCollectionSelected(
    @Param('collectionId') collectionId: string,
    @Req() req: any,
    @Body() body: BagCollectionSelectedDto,
  ) {
    return this.collectionBaggingService.bagSelected(
      collectionId,
      req.user.id,
      body,
    );
  }
}
