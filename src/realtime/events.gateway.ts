import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PrismaService } from 'src/prisma/prisma.service';
import { CollectionVisibility } from '@prisma/client';

@WebSocketGateway({ cors: { origin: '*' } })
export class EventsGateway {
  @WebSocketServer() server!: Server;
  constructor(private readonly prisma: PrismaService) {}

  private async canViewCollection(collectionId: string, userId?: string) {
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
  }

  @SubscribeMessage('join')
  handleJoin(
    @MessageBody() data: { room: string; userId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const run = async () => {
      const room = data?.room;
      const userId = data?.userId;
      if (!room) return;
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
        const ok = await this.canViewCollection(id, userId);
        if (!ok) return client.emit('join.denied', { room });
        client.join(room); client.emit('joined', { room });
        return;
      }
      if (type === 'COLLECTION_MEDIA') {
        const media = await this.prisma.collectionMedia.findUnique({ where: { id }, select: { collectionId: true } });
        if (!media) return client.emit('join.denied', { room });
        const ok = await this.canViewCollection(media.collectionId, userId);
        if (!ok) return client.emit('join.denied', { room });
        client.join(room); client.emit('joined', { room });
        return;
      }
      // Default: join
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
