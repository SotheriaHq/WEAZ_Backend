import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { MarketSectionController } from './market-section.controller';
import { MarketSectionService } from './market-section.service';

@Module({
  imports: [PrismaModule],
  controllers: [MarketSectionController],
  providers: [MarketSectionService],
  exports: [MarketSectionService],
})
export class MarketModule {}
