import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { BagCountPresenter } from './bag-count.presenter';
import { BagEligibilityService } from './bag-eligibility.service';

@Controller('bag')
export class BaggingController {
  constructor(
    private readonly eligibilityService: BagEligibilityService,
    private readonly countPresenter: BagCountPresenter,
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
    return this.eligibilityService.getSourceBagStatus(sourceType, sourceId, req.user?.id);
  }
}
