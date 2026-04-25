import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsEmailWebhookController {
  private readonly logger = new Logger(
    NotificationsEmailWebhookController.name,
  );

  constructor(private readonly notifications: NotificationsService) {}

  @Post('email-webhooks/:provider')
  @HttpCode(202)
  async ingestWebhook(
    @Param('provider') provider: string,
    @Headers('x-email-webhook-signature') signature: string | undefined,
    @Headers('authorization') authorizationHeader: string | undefined,
    @Body() payload: Record<string, unknown> | null,
  ) {
    const eventType = String(payload?.eventType ?? payload?.event ?? 'unknown');
    this.logger.log(
      `Email webhook ingress provider=${provider} event=${eventType} hasSignature=${signature ? 'true' : 'false'} hasBasicAuth=${authorizationHeader ? 'true' : 'false'}`,
    );

    return this.notifications.handleEmailWebhook(
      provider,
      signature,
      payload,
      authorizationHeader,
    );
  }
}
