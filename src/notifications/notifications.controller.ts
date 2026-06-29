import {
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Query,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
  Body,
  ValidationPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { ListNotificationsQueryDto } from './dto';
import {
  DeactivateCurrentPushTokenDto,
  RegisterPushTokenDto,
} from './push-token.dto';
import { PushDeviceTokensService } from './push-device-tokens.service';
import { PushNotificationsService } from './push-notifications.service';

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly service: NotificationsService,
    private readonly pushTokens: PushDeviceTokensService,
    private readonly pushNotifications: PushNotificationsService,
  ) {}

  /**
   * Ops/admin read-only view of native push delivery health: outbox status
   * breakdown, pending backlog, exhausted (DLQ) count, active tokens, and the
   * receipt-error histogram for the window. Powers Phase 3 observability.
   */
  @Get('push/metrics')
  @UseGuards(RolesGuard)
  @Roles(Role.SuperAdmin, Role.Admin)
  async pushMetrics(@Query('windowHours') windowHours?: string) {
    const parsed = Number(windowHours);
    const hours =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 168) : 24;
    return this.pushNotifications.getPushDeliveryMetrics(hours);
  }

  @Get()
  async list(@Req() req: any, @Query() q: ListNotificationsQueryDto) {
    return this.service.list(req.user.id, q);
  }

  @Get('unread-count')
  async unreadCount(@Req() req: any) {
    return this.service.unreadCount(req.user.id);
  }

  @Post('push-tokens')
  async registerPushToken(
    @Req() req: any,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RegisterPushTokenDto,
  ) {
    return this.pushTokens.register(req.user.id, dto);
  }

  @Get('push-tokens')
  async listPushTokens(@Req() req: any) {
    return this.pushTokens.listMine(req.user.id);
  }

  @Delete('push-tokens/current')
  async deactivateCurrentPushToken(
    @Req() req: any,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: DeactivateCurrentPushTokenDto,
  ) {
    return this.pushTokens.deactivateCurrent(req.user.id, dto);
  }

  @Patch('push-tokens/:id/deactivate')
  async deactivatePushTokenById(
    @Req() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.pushTokens.deactivateById(req.user.id, id);
  }

  @Patch(':id/read')
  async markRead(@Req() req: any, @Param('id') id: string) {
    return this.service.markRead(req.user.id, id);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } }) // 10 requests per minute
  @Post('mark-all-read')
  async markAll(@Req() req: any) {
    return this.service.markAllRead(req.user.id);
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    return this.service.remove(req.user.id, id);
  }

  @Get('settings')
  async getSettings(@Req() req: any) {
    return this.service.getSettings(req.user.id);
  }

  @Patch('settings')
  async updateSettings(@Req() req: any, @Body() body: any) {
    return this.service.updateSettings(req.user.id, body);
  }

  @Get('email-settings')
  async getEmailSettings(@Req() req: any) {
    return this.service.getEmailSettings(req.user.id);
  }

  @Patch('email-settings')
  async updateEmailSettings(@Req() req: any, @Body() body: any) {
    return this.service.updateEmailSettings(req.user.id, body);
  }

  @Post('email-settings/reset-defaults')
  async resetEmailSettings(@Req() req: any) {
    return this.service.resetEmailSettings(req.user.id);
  }
}
