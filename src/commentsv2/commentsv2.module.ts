import { Module } from '@nestjs/common';
import { CommentsV2Controller } from './commentsv2.controller';
import { CommentsV2Service } from './commentsv2.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EventsGateway } from 'src/realtime/events.gateway';

@Module({
  controllers: [CommentsV2Controller],
  providers: [CommentsV2Service, PrismaService, EventsGateway],
})
export class CommentsV2Module {}

