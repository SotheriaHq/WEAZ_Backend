import { Module } from '@nestjs/common';
import { CustomOrdersModule } from 'src/custom-orders/custom-orders.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { CustomOrderAdminController } from './custom-order-admin.controller';
import { CustomOrderAdminService } from './custom-order-admin.service';

@Module({
  imports: [PrismaModule, CustomOrdersModule],
  controllers: [CustomOrderAdminController],
  providers: [CustomOrderAdminService],
})
export class CustomOrderAdminModule {}
