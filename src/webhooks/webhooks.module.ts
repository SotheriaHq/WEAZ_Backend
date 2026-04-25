import { Module } from '@nestjs/common';
import { PaymentModule } from 'src/payment/payment.module';
import { AdminModule } from 'src/admin/admin.module';
import { PaystackWebhookController } from './paystack-webhook.controller';

@Module({
  imports: [PaymentModule, AdminModule],
  controllers: [PaystackWebhookController],
})
export class WebhooksModule {}
