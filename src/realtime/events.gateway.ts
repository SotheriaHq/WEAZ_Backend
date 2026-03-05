import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CollectionVisibility } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { AuthJwtClaims } from 'src/auth/dto/auth-response.dto';
import * as jwt from 'jsonwebtoken';

const defaultWsOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:4174',
];

const wsAllowedOrigins = [
  ...(process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
  ...defaultWsOrigins,
].filter((origin, index, arr) => arr.indexOf(origin) === index);

@WebSocketGateway({
  cors: {
    origin: wsAllowedOrigins,
    credentials: true,
  },
})
export class EventsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(EventsGateway.name);
  private readonly joinWindowMs = 10_000;
  private readonly maxJoinRequestsPerWindow = 30;
  private readonly maxRoomsPerSocket = 120;
  private readonly joinCounters = new Map<
    string,
    { windowStart: number; count: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async handleConnection(client: Socket) {
    const userId = await this.authenticateSocket(client);
    if (!userId) {
      client.emit('join.denied', { reason: 'unauthorized' });
      client.disconnect(true);
      return;
    }
    client.data.userId = userId;
  }

  handleDisconnect(client: Socket) {
    this.joinCounters.delete(client.id);
  }

  private get accessTokenCookieName(): string {
    return this.configService.get<string>('ACCESS_TOKEN_COOKIE', 'accessToken');
  }

  private get accessTokenSecret(): string {
    const secret = this.configService.get<string>('JWT_ACCESS_SECRET');
    if (!secret) {
      throw new Error('JWT_ACCESS_SECRET must be configured for websocket auth');
    }
    return secret;
  }

  private extractCookieValue(cookieHeader: string | undefined, key: string) {
    if (!cookieHeader) return null;
    const cookies = cookieHeader.split(';');
    for (const chunk of cookies) {
      const [k, ...rest] = chunk.trim().split('=');
      if (k === key) {
        return decodeURIComponent(rest.join('=') ?? '');
      }
    }
    return null;
  }

  private extractHandshakeToken(client: Socket): string | null {
    const authToken = client.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken.trim().length > 0) {
      return authToken.trim();
    }

    const authHeader = client.handshake.headers?.authorization;
    if (typeof authHeader === 'string') {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match?.[1]) return match[1].trim();
    }

    const cookieHeader = client.handshake.headers?.cookie;
    return this.extractCookieValue(cookieHeader, this.accessTokenCookieName);
  }

  private async authenticateSocket(client: Socket): Promise<string | null> {
    try {
      const rawToken = this.extractHandshakeToken(client);
      if (!rawToken) return null;

      const claims = jwt.verify(rawToken, this.accessTokenSecret) as AuthJwtClaims;
      if (!claims?.sub) return null;

      const user = await this.prisma.user.findUnique({
        where: { id: claims.sub },
        select: { id: true, isActive: true },
      });
      if (!user || user.isActive === 'Inactive') return null;
      return user.id;
    } catch {
      return null;
    }
  }

  private isJoinRateLimited(client: Socket): boolean {
    const now = Date.now();
    const existing = this.joinCounters.get(client.id);
    if (!existing || now - existing.windowStart >= this.joinWindowMs) {
      this.joinCounters.set(client.id, { windowStart: now, count: 1 });
      return false;
    }
    existing.count += 1;
    this.joinCounters.set(client.id, existing);
    return existing.count > this.maxJoinRequestsPerWindow;
  }

  private hasRoomCapacity(client: Socket, room: string): boolean {
    if (client.rooms.has(room)) return true;
    const joinedRooms = Math.max(client.rooms.size - 1, 0); // excludes private socket room
    return joinedRooms < this.maxRoomsPerSocket;
  }

  /**
   * Lightweight UUID format validation (accepts standard 36-char with hyphens).
   * Prevents Prisma P2023 errors when an empty or malformed id is passed.
   */
  private isValidUuid(id?: string): boolean {
    if (!id) return false;
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      id,
    );
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
      this.logger.debug(
        `canViewCollection failed for id='${collectionId}': ${err?.code ?? err}`,
      );
      return false;
    }
  }

  @SubscribeMessage('join')
  handleJoin(
    @MessageBody() data: { room: string },
    @ConnectedSocket() client: Socket,
  ) {
    const run = async () => {
      try {
        const room = data?.room?.trim();
        const userId = client.data?.userId as string | undefined;
        if (!room) return; // silently ignore blank
        if (!userId) {
          client.emit('join.denied', { room, reason: 'unauthorized' });
          return;
        }
        if (this.isJoinRateLimited(client)) {
          client.emit('join.denied', { room, reason: 'rate_limited' });
          return;
        }
        if (!this.hasRoomCapacity(client, room)) {
          client.emit('join.denied', { room, reason: 'room_limit' });
          return;
        }
        // USER room join must match self
        if (room.startsWith('USER:')) {
          if (room !== `USER:${userId}`) {
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
          client.join(room);
          client.emit('joined', { room });
          return;
        }
        if (type === 'COLLECTION_MEDIA') {
          if (!this.isValidUuid(id)) {
            client.emit('join.denied', { room });
            return;
          }
          const media = await this.prisma.collectionMedia
            .findUnique({ where: { id }, select: { collectionId: true } })
            .catch((e) => {
              this.logger.debug(
                `Lookup media failed id='${id}': ${e?.code ?? e}`,
              );
              return null;
            });
          if (!media) return client.emit('join.denied', { room });
          const ok = await this.canViewCollection(media.collectionId, userId);
          if (!ok) return client.emit('join.denied', { room });
          client.join(room);
          client.emit('joined', { room });
          return;
        }
        if (type === 'COMMENT') {
          if (!this.isValidUuid(id)) {
            client.emit('join.denied', { room });
            return;
          }
          client.join(room);
          client.emit('joined', { room });
          return;
        }
        // Unknown room type is denied by default.
        client.emit('join.denied', { room, reason: 'unsupported_room' });
      } catch (error: any) {
        this.logger.warn(`Join failed: ${error?.message ?? error}`);
      }
    };
    void run();
  }

  emitThread(
    event: 'thread.created' | 'thread.removed',
    payload: {
      contentType: string;
      contentId: string;
      userId: string;
      threadCount: number;
    },
  ) {
    const room = `${payload.contentType}:${payload.contentId}`;
    this.server
      .to(room)
      .emit(event, { ...payload, version: 1, ts: Date.now() });
  }

  // Comment events (rooms may be target rooms or COMMENT:{id} for threads on a comment)
  emitComment(
    event: 'comment.created' | 'comment.deleted' | 'comment.threaded',
    room: string,
    payload: any,
  ) {
    this.server
      .to(room)
      .emit(event, { ...payload, version: 1, ts: Date.now() });
  }
}
