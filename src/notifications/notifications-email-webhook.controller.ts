import { Body, Controller, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsEmailWebhookController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post('email-webhooks/:provider')
  @HttpCode(202)
  async ingestWebhook(
    @Param('provider') provider: string,
    @Headers('x-email-webhook-signature') signature: string | undefined,
    @Body() payload: Record<string, unknown> | null,
  ) {
    return this.notifications.handleEmailWebhook(provider, signature, payload);
  }
}
