import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { FinanceModule } from 'src/finance/finance.module';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { CustomOrderQueueService } from './custom-order-queue.service';
import { AdminCustomOrderQueueController, CustomOrderQueueController } from './custom-order-queue.controller';
import { CustomOrderQueueRefundsService } from './custom-order-queue-refunds.service';
import { CustomOrderQueueCronService } from './custom-order-queue.cron';

@Module({ imports: [PrismaModule, FinanceModule], providers: [CustomOrderQueueService, CustomOrderQueueRefundsService, CustomOrderQueueCronService, BrandPermissionService], controllers: [CustomOrderQueueController, AdminCustomOrderQueueController], exports: [CustomOrderQueueService, CustomOrderQueueRefundsService] })
export class CustomOrderQueueModule {}
