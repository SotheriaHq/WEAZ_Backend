import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { MessagingService } from '../messaging.service';
import {
  MarkThreadReadDto,
  QueryInboxDto,
  QueryMessagesDto,
  QueryThreadOrdersDto,
  ResolveConversationQueryDto,
  SendMessageDto,
  StartConversationDto,
} from '../dto/messaging.dto';

@Controller('messaging')
@UseGuards(JwtAuthGuard)
export class MessagingInboxController {
  constructor(private readonly messaging: MessagingService) {}

  @Get('inbox')
  async inbox(
    @Req() req: { user: { id: string } },
    @Query() query: QueryInboxDto,
  ) {
    return this.messaging.getInboxForActor(req.user.id, query);
  }

  @Get('unread-count')
  async unreadCount(@Req() req: { user: { id: string } }) {
    return this.messaging.getUnreadMessageCountForActor(req.user.id);
  }

  @Get('conversations/resolve')
  async resolveConversation(
    @Req() req: { user: { id: string } },
    @Query() query: ResolveConversationQueryDto,
  ) {
    return this.messaging.resolveConversationForActor(req.user.id, query);
  }

  @Post('conversations/start')
  async startConversation(
    @Req() req: { user: { id: string } },
    @Body() dto: StartConversationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.messaging.startConversationForActor(
      req.user.id,
      dto,
      idempotencyKey,
    );
  }

  @Get('threads/:threadId/resolve')
  async resolveThread(
    @Req() req: { user: { id: string } },
    @Param('threadId') threadId: string,
  ) {
    return this.messaging.resolveThreadForActor(req.user.id, threadId);
  }

  @Get('threads/:threadId/messages')
  async listThreadMessages(
    @Req() req: { user: { id: string } },
    @Param('threadId') threadId: string,
    @Query() query: QueryMessagesDto,
  ) {
    return this.messaging.listThreadMessagesForActor(
      req.user.id,
      threadId,
      query,
    );
  }

  @Get('threads/:threadId/orders')
  async listThreadOrders(
    @Req() req: { user: { id: string } },
    @Param('threadId') threadId: string,
    @Query() query: QueryThreadOrdersDto,
  ) {
    return this.messaging.listThreadOrdersForActor(
      req.user.id,
      threadId,
      query,
    );
  }

  @Post('brands/:brandId/messages')
  async sendBrandEntryMessage(
    @Req() req: { user: { id: string } },
    @Param('brandId') brandId: string,
    @Body() dto: SendMessageDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.messaging.sendBrandEntryMessage(
      req.user.id,
      brandId,
      dto,
      idempotencyKey,
    );
  }

  @Post('threads/:threadId/messages')
  async sendThreadMessage(
    @Req() req: { user: { id: string } },
    @Param('threadId') threadId: string,
    @Body() dto: SendMessageDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.messaging.sendMessageToThread(
      req.user.id,
      threadId,
      dto,
      idempotencyKey,
    );
  }

  @Post('threads/:threadId/read')
  async markThreadRead(
    @Req() req: { user: { id: string } },
    @Param('threadId') threadId: string,
    @Body() dto: MarkThreadReadDto,
  ) {
    return this.messaging.markThreadReadById(req.user.id, threadId, dto);
  }
}
