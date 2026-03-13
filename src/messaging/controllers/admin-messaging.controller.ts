import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { ADMIN_PERMISSIONS } from 'src/admin/constants/permissions';
import { RequirePermissions } from 'src/admin/decorators/require-permissions.decorator';
import { AdminPermissionGuard } from 'src/admin/guards/admin-permission.guard';
import { MessagingService } from '../messaging.service';
import { AdminSystemMessageDto, ModerateMessageDto, QueryMessagesDto } from '../dto/messaging.dto';

@Controller('admin/messaging')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminMessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Get('threads/:threadId')
  @RequirePermissions(ADMIN_PERMISSIONS.MESSAGING_READ)
  async getThread(
    @Req() req: Request & { user: { id: string } },
    @Param('threadId') threadId: string,
  ) {
    return this.messaging.getAdminThread(req.user.id, threadId);
  }

  @Get('threads/:threadId/messages')
  @RequirePermissions(ADMIN_PERMISSIONS.MESSAGING_READ)
  async getThreadMessages(
    @Req() req: Request & { user: { id: string } },
    @Param('threadId') threadId: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryMessagesDto,
  ) {
    return this.messaging.getAdminThreadMessages(req.user.id, threadId, query);
  }

  @Get('custom-orders/:orderId/messages')
  @RequirePermissions(ADMIN_PERMISSIONS.MESSAGING_READ)
  async getCustomOrderMessages(
    @Param('orderId') orderId: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryMessagesDto,
  ) {
    return this.messaging.getAdminMessagesForContext('CUSTOM_ORDER', orderId, query);
  }

  @Get('orders/:orderId/messages')
  @RequirePermissions(ADMIN_PERMISSIONS.MESSAGING_READ)
  async getOrderMessages(
    @Param('orderId') orderId: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: QueryMessagesDto,
  ) {
    return this.messaging.getAdminMessagesForContext('STANDARD_ORDER', orderId, query);
  }

  @Post('messages/:messageId/hide')
  @RequirePermissions(ADMIN_PERMISSIONS.MESSAGING_MODERATE)
  async hideMessage(
    @Req() req: Request & { user: { id: string } },
    @Param('messageId') messageId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: ModerateMessageDto,
  ) {
    return this.messaging.hideMessage(req.user.id, messageId, dto.reason, req);
  }

  @Post('messages/:messageId/redact')
  @RequirePermissions(ADMIN_PERMISSIONS.MESSAGING_MODERATE)
  async redactMessage(
    @Req() req: Request & { user: { id: string } },
    @Param('messageId') messageId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: ModerateMessageDto,
  ) {
    return this.messaging.redactMessage(req.user.id, messageId, dto.reason, req);
  }

  @Post('threads/:threadId/reopen')
  @RequirePermissions(ADMIN_PERMISSIONS.MESSAGING_MODERATE)
  async reopenThread(
    @Req() req: Request & { user: { id: string } },
    @Param('threadId') threadId: string,
  ) {
    return this.messaging.reopenThread(req.user.id, threadId, req);
  }

  @Post('threads/:threadId/system-message')
  @RequirePermissions(ADMIN_PERMISSIONS.MESSAGING_MODERATE)
  async addSystemMessage(
    @Req() req: Request & { user: { id: string } },
    @Param('threadId') threadId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: AdminSystemMessageDto,
  ) {
    return this.messaging.addSystemMessage(req.user.id, threadId, dto, req);
  }
}
