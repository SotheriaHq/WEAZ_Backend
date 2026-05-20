import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { MeasurementNormalizationService } from './measurement-normalization.service';
import { SizeComputationService } from './size-computation.service';

@Module({
  imports: [PrismaModule],
  providers: [MeasurementNormalizationService, SizeComputationService],
  exports: [MeasurementNormalizationService, SizeComputationService],
})
export class SizingModule {}
