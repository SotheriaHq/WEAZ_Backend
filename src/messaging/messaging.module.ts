import { Module } from '@nestjs/common';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';
import { QueueModule } from 'src/queue/queue.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { CustomOrderMessagingBuyerController } from './controllers/custom-order-messaging-buyer.controller';
import { CustomOrderMessagingBrandController } from './controllers/custom-order-messaging-brand.controller';
import { OrderMessagingBuyerController } from './controllers/order-messaging-buyer.controller';
import { OrderMessagingBrandController } from './controllers/order-messaging-brand.controller';
import { AdminMessagingController } from './controllers/admin-messaging.controller';
import { MessagingSummaryBuyerController } from './controllers/messaging-summary-buyer.controller';
import { MessagingSummaryBrandController } from './controllers/messaging-summary-brand.controller';
import { MessagingInboxController } from './controllers/messaging-inbox.controller';
import { MessagingAttachmentService } from './messaging-attachment.service';
import { MessagingPolicyService } from './messaging-policy.service';
import { MessagingQueryService } from './messaging-query.service';
import { MessagingService } from './messaging.service';
import { MessagingSideEffectsService } from './messaging-side-effects.service';
import { UploadModule } from 'src/upload/upload.module';
import { CustomOrdersModule } from 'src/custom-orders/custom-orders.module';

@Module({
  imports: [PrismaModule, QueueModule, UploadModule, CustomOrdersModule],
  controllers: [
    CustomOrderMessagingBuyerController,
    CustomOrderMessagingBrandController,
    OrderMessagingBuyerController,
    OrderMessagingBrandController,
    AdminMessagingController,
    MessagingSummaryBuyerController,
    MessagingSummaryBrandController,
    MessagingInboxController,
  ],
  providers: [
    MessagingService,
    MessagingQueryService,
    MessagingPolicyService,
    MessagingAttachmentService,
    MessagingSideEffectsService,
    AdminAuditService,
  ],
  exports: [MessagingService],
})
export class MessagingModule {}
