import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { MeasurementNormalizationService } from './measurement-normalization.service';
import { SizeComputationService } from './size-computation.service';
import { SizingDataGuard } from './sizing-data.guard';

@Module({
  imports: [PrismaModule],
  providers: [MeasurementNormalizationService, SizeComputationService, SizingDataGuard],
  exports: [MeasurementNormalizationService, SizeComputationService, SizingDataGuard],
})
export class SizingModule {}
