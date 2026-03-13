import { Module } from '@nestjs/common';
import { CustomOrdersModule } from 'src/custom-orders/custom-orders.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { CustomOrderOpsCronService } from './custom-order-ops.cron.service';

@Module({
  imports: [PrismaModule, CustomOrdersModule],
  providers: [CustomOrderOpsCronService],
})
export class CustomOrderOpsModule {}