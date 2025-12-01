import {
  Controller,
  Get,
  Patch,
  Post,
  Query,
  Param,
  Req,
  UseGuards,
  Body,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { ListNotificationsQueryDto } from './dto';

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) { }

  @Get()
  async list(@Req() req: any, @Query() q: ListNotificationsQueryDto) {
    return this.service.list(req.user.id, q);
  }

  @Get('unread-count')
  async unreadCount(@Req() req: any) {
    return this.service.unreadCount(req.user.id);
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

  @Get('settings')
  async getSettings(@Req() req: any) {
    return this.service.getSettings(req.user.id);
  }

  @Patch('settings')
  async updateSettings(@Req() req: any, @Body() body: any) {
    return this.service.updateSettings(req.user.id, body);
  }
}
