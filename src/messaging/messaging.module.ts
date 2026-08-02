import { forwardRef, Module } from '@nestjs/common';
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
import { CustomOrderThreadBootstrapService } from './custom-order-thread-bootstrap.service';
import { MessagingPolicyService } from './messaging-policy.service';
import { MessagingQueryService } from './messaging-query.service';
import { MessagingAccessService } from './messaging-access.service';
import { MessagingService } from './messaging.service';
import { MessagingSideEffectsService } from './messaging-side-effects.service';
import { UploadModule } from 'src/upload/upload.module';
import { CustomOrdersModule } from 'src/custom-orders/custom-orders.module';
import { SystemConfigModule } from 'src/admin/system-config/system-config.module';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { EventsGateway } from 'src/realtime/events.gateway';

@Module({
  imports: [
    PrismaModule,
    QueueModule,
    UploadModule,
    forwardRef(() => CustomOrdersModule),
    SystemConfigModule,
  ],
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
    CustomOrderThreadBootstrapService,
    MessagingQueryService,
    MessagingPolicyService,
    MessagingAccessService,
    MessagingAttachmentService,
    MessagingSideEffectsService,
    AdminAuditService,
    BrandPermissionService,
    // MessagingSideEffectsService injects EventsGateway with @Optional(). Without
    // this provider Nest resolved it to `undefined`, so EVERY messaging realtime
    // emit — message.created / thread.updated / message.read — was a silent
    // no-op: inboxes never refreshed, unread counts never moved, and read state
    // never propagated to the sender. The web/mobile clients were listening the
    // whole time; the server simply never spoke. Mirrors how collections,
    // commentsv2, notifications and posts register the gateway.
    EventsGateway,
  ],
  exports: [
    MessagingService,
    CustomOrderThreadBootstrapService,
    MessagingAccessService,
  ],
})
export class MessagingModule {}
