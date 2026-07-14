import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { BagCountPresenter } from './bag-count.presenter';
import { BagEligibilityService } from './bag-eligibility.service';
import { BagReadinessPresenter } from './bag-readiness.presenter';
import { BagValidationService } from './bag-validation.service';
import { BaggingController } from './bagging.controller';
import { CollectionBaggingService } from './collection-bagging.service';
import { FittingFreshnessPolicy } from './fitting-freshness.policy';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [BaggingController],
  providers: [
    BagEligibilityService,
    BagValidationService,
    BagReadinessPresenter,
    BagCountPresenter,
    CollectionBaggingService,
    FittingFreshnessPolicy,
  ],
  exports: [
    BagEligibilityService,
    BagValidationService,
    BagReadinessPresenter,
    BagCountPresenter,
    CollectionBaggingService,
    FittingFreshnessPolicy,
  ],
})
export class BaggingModule {}
