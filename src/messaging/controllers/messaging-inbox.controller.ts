import { Body, Controller, Get, Headers, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { MessagingService } from '../messaging.service';
import { MarkThreadReadDto, QueryInboxDto, QueryMessagesDto, SendMessageDto } from '../dto/messaging.dto';

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
    return this.messaging.listThreadMessagesForActor(req.user.id, threadId, query);
  }

  @Post('threads/:threadId/messages')
  async sendThreadMessage(
    @Req() req: { user: { id: string } },
    @Param('threadId') threadId: string,
    @Body() dto: SendMessageDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.messaging.sendMessageToThread(req.user.id, threadId, dto, idempotencyKey);
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
