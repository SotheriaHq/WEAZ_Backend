import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CollectionVisibility } from '@prisma/client';

@WebSocketGateway({ cors: { origin: '*' } })
export class EventsGateway {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(EventsGateway.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lightweight UUID format validation (accepts standard 36-char with hyphens).
   * Prevents Prisma P2023 errors when an empty or malformed id is passed.
   */
  private isValidUuid(id?: string): boolean {
    if (!id) return false;
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);
  }

  private async canViewCollection(collectionId: string, userId?: string) {
    // Guard invalid/empty ids early
    if (!this.isValidUuid(collectionId)) return false;
    try {
      const c = await this.prisma.collection.findUnique({
        where: { id: collectionId },
        select: { ownerId: true, status: true, visibility: true },
      });
      if (!c || c.status !== 'PUBLISHED') return false;
      if (c.visibility === CollectionVisibility.PUBLIC) return true;
      if (userId && userId === c.ownerId) return true;
      if (userId) {
        const access = await this.prisma.collectionAccess.findUnique({
          where: { collectionId_viewerId: { collectionId, viewerId: userId } },
          select: { state: true },
        });
        return access?.state === 'APPROVED';
      }
      return false;
    } catch (err: any) {
      // Suppress noisy P2023 errors; treat as not viewable.
      this.logger.debug(`canViewCollection failed for id='${collectionId}': ${err?.code ?? err}`);
      return false;
    }
  }

  @SubscribeMessage('join')
  handleJoin(
    @MessageBody() data: { room: string; userId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const run = async () => {
      const room = data?.room?.trim();
      const userId = data?.userId;
      if (!room) return; // silently ignore blank
      // USER room join must match self
      if (room.startsWith('USER:')) {
        if (!userId || room !== `USER:${userId}`) {
          client.emit('join.denied', { room });
          return;
        }
        client.join(room);
        client.emit('joined', { room });
        return;
      }
      // COLLECTION / COLLECTION_MEDIA scoped joins
      const [type, id] = room.split(':');
      if (type === 'COLLECTION') {
        if (!this.isValidUuid(id)) {
          client.emit('join.denied', { room });
          return;
        }
        const ok = await this.canViewCollection(id, userId);
        if (!ok) return client.emit('join.denied', { room });
        client.join(room); client.emit('joined', { room });
        return;
      }
      if (type === 'COLLECTION_MEDIA') {
        if (!this.isValidUuid(id)) {
          client.emit('join.denied', { room });
          return;
        }
        const media = await this.prisma.collectionMedia.findUnique({ where: { id }, select: { collectionId: true } }).catch((e) => {
          this.logger.debug(`Lookup media failed id='${id}': ${e?.code ?? e}`);
          return null;
        });
        if (!media) return client.emit('join.denied', { room });
        const ok = await this.canViewCollection(media.collectionId, userId);
        if (!ok) return client.emit('join.denied', { room });
        client.join(room); client.emit('joined', { room });
        return;
      }
      // Default: join (no validation needed)
      client.join(room);
      client.emit('joined', { room });
    };
    void run();
  }

  emitLike(
    event: 'like.created' | 'like.removed',
    payload: {
      contentType: string;
      contentId: string;
      userId: string;
      likeCount: number;
    },
  ) {
    const room = `${payload.contentType}:${payload.contentId}`;
    this.server
      .to(room)
      .emit(event, { ...payload, version: 1, ts: Date.now() });
  }

  // Comment events (rooms may be target rooms or COMMENT:{id} for likes on a comment)
  emitComment(
    event: 'comment.created' | 'comment.deleted' | 'comment.liked',
    room: string,
    payload: any,
  ) {
    this.server
      .to(room)
      .emit(event, { ...payload, version: 1, ts: Date.now() });
  }
}
