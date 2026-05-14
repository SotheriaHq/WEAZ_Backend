import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { BagCountPresenter } from './bag-count.presenter';
import { BagEligibilityService } from './bag-eligibility.service';
import { BagReadinessPresenter } from './bag-readiness.presenter';
import { BagValidationService } from './bag-validation.service';
import { BaggingController } from './bagging.controller';
import { FittingFreshnessPolicy } from './fitting-freshness.policy';

@Module({
  imports: [PrismaModule],
  controllers: [BaggingController],
  providers: [
    BagEligibilityService,
    BagValidationService,
    BagReadinessPresenter,
    BagCountPresenter,
    FittingFreshnessPolicy,
  ],
  exports: [
    BagEligibilityService,
    BagValidationService,
    BagReadinessPresenter,
    BagCountPresenter,
    FittingFreshnessPolicy,
  ],
})
export class BaggingModule {}
