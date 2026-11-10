import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { applyRealtimeSecurityHeaders } from 'src/common/middleware/security-headers';
import { PrismaService } from 'src/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { AuthJwtClaims } from 'src/auth/dto/auth-response.dto';
import { resolveCurrentPrincipal } from 'src/auth/access/current-principal';
import { getJwtVerificationSecrets } from 'src/common/config/jwt-secrets';
import * as jwt from 'jsonwebtoken';
import { contentAudience, resourceUuid, type ContentTarget } from 'src/common/content-audience';
import { authorizedSockets } from './socket-authority';
import { NotificationRealtimeBusService, type NotificationRealtimeBusEvent, type NotificationRealtimeEventName } from './notification-realtime-bus.service';

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
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, OnModuleDestroy, OnModuleInit {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(EventsGateway.name);
  private unregisterDelivery?: () => void;
  private closed = false;
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    private readonly realtimeBus: NotificationRealtimeBusService,
  ) {}

  onModuleInit() {
    this.unregisterDelivery = this.realtimeBus.registerLocalDelivery(event => this.emitAuthorizedLocal(event));
  }

  /**
   * Engine.IO answers `/socket.io/` on the raw HTTP server, before Express,
   * so the API's security headers never reached these responses. Its
   * `headers` event fires for every polling response and the WebSocket
   * upgrade; one listener, registered once per process.
   */
  afterInit(server: Server) {
    server?.engine?.on?.('headers', applyRealtimeSecurityHeaders);
    // Namespace middleware finishes identity verification before the client can
    // receive `connect` and immediately send its first room join.
    server.use(async (client, next) => {
      const userId = await this.authenticateSocket(client);
      if (!userId) return next(new Error('Unauthorized'));
      client.data.userId = userId;
      next();
    });
  }

  async handleConnection(client: Socket) {
    const userId = client.data?.userId && client.data?.principalClaims ? client.data.userId : await this.authenticateSocket(client);
    if (!userId) {
      client.emit('join.denied', { reason: 'unauthorized' });
      client.disconnect(true);
      return;
    }
    if (!client.connected) return;
    client.data.userId = userId;
    this.scheduleExpiry(client);
  }

  private scheduleExpiry(client: Socket) {
    const previous = this.expiryTimers.get(client.id);
    if (previous) clearTimeout(previous);
    const remaining = client.data.accessExpiresAt - Date.now();
    if (remaining <= 0) { client.disconnect(true); return; }
    const timer = setTimeout(() => {
      this.expiryTimers.delete(client.id);
      this.scheduleExpiry(client);
    }, Math.min(remaining, 2_147_483_647));
    timer.unref();
    this.expiryTimers.set(client.id, timer);
  }

  handleDisconnect(client: Socket) {
    this.joinCounters.delete(client.id);
    const timer = this.expiryTimers.get(client.id);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(client.id);
  }

  onModuleDestroy() {
    this.closed = true;
    this.unregisterDelivery?.();
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.joinCounters.clear();
  }

  private get accessTokenCookieName(): string {
    return this.configService.get<string>('ACCESS_TOKEN_COOKIE', 'accessToken');
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

      let claims: (AuthJwtClaims & jwt.JwtPayload) | undefined;
      for (const secret of getJwtVerificationSecrets(this.configService)) {
        try { claims = jwt.verify(rawToken, secret, { algorithms: ['HS256'] }) as AuthJwtClaims & jwt.JwtPayload; break; }
        catch { /* Try the explicitly configured rotation key. */ }
      }
      if (!claims?.sub || !Number.isFinite(claims.exp)) return null;
      const principal = await resolveCurrentPrincipal(this.prisma, claims);
      client.data.principalClaims = claims;
      client.data.accessExpiresAt = claims.exp * 1000;
      return principal.id;
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

  @SubscribeMessage('join')
  handleJoin(
    @MessageBody() data: { room: string },
    @ConnectedSocket() client: Socket,
  ) {
    const run = async () => {
      try {
        if (typeof data?.room === 'string' && data.room.length > 64) {
          client.emit('join.denied', { reason: 'invalid_room' });
          return;
        }
        const room = typeof data?.room === 'string' ? data.room.trim() : '';
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
        try {
          if (!client.data.principalClaims || client.data.accessExpiresAt <= Date.now()) throw new Error('expired');
          await resolveCurrentPrincipal(this.prisma, client.data.principalClaims);
        } catch {
          client.emit('join.denied', { reason: 'unauthorized' });
          client.disconnect(true);
          return;
        }
        if (!client.connected) return;
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
        const [type, id, extra] = room.split(':');
        if (!extra && ['POST', 'COLLECTION', 'COLLECTION_MEDIA', 'DESIGN', 'PRODUCT', 'COMMENT'].includes(type) && this.isValidUuid(id)) {
          const viewers = await contentAudience(this.prisma, type as ContentTarget, id, [userId]);
          if (!viewers.has(userId) || !client.connected || !this.hasRoomCapacity(client, room))
            return client.emit('join.denied', { room });
          await client.join(room);
          client.emit('joined', { room });
          return;
        }
        // Unknown room type is denied by default.
        client.emit('join.denied', { room, reason: 'unsupported_room' });
      } catch (error: any) {
        this.logger.warn(`Join failed: ${error?.message ?? error}`);
      }
    };
    return run();
  }

  /**
   * Which of these users currently has a live connection.
   *
   * "Delivered" means the message reached the recipient's device. The only
   * thing that actually knows that is the socket layer: a user with at least
   * one socket in their `USER:` room is holding the connection the message is
   * being pushed down, so by the time this resolves the push has been handed to
   * them. Everything else in the system infers delivery after the fact — the
   * previous implementation waited for the recipient to OPEN the thread and
   * fetch it, which is why a message sat on one tick until it was already read.
   *
   * Presence is read per user rather than in one sweep because `fetchSockets()`
   * is room-scoped, and because it must not fail as a group: one user whose
   * lookup throws should cost that user's receipt, not everyone's.
   */
  async getConnectedUserIds(userIds: string[]): Promise<string[]> {
    if (!this.server || this.closed) return [];
    const unique = [...new Set(userIds.filter(id => resourceUuid.test(id)))];
    const connected = new Set<string>(); let pending: Socket[] = [];
    const check = async () => {
      for (const socket of await authorizedSockets(this.prisma, pending)) connected.add(socket.data.userId);
      pending = [];
    };
    try {
      for (const userId of unique) {
        for (const batch of this.socketBatches(`USER:${userId}`)) {
          for (const socket of batch) {
            if (connected.has(userId) || socket.data.userId !== userId) continue;
            pending.push(socket); if (pending.length === 100) await check();
          }
        }
      }
      if (pending.length) await check();
    } catch { return []; } // An unavailable authority store cannot prove presence.
    return [...connected];
  }

  @SubscribeMessage('leave')
  async handleLeave(@MessageBody() data: { room: string }, @ConnectedSocket() client: Socket) {
    const room = typeof data?.room === 'string' && data.room.length <= 64 ? data.room : '';
    const [type, id, extra] = room.split(':');
    // Leaving grants no authority and never touches another socket's rooms.
    if (extra || !['USER', 'POST', 'COLLECTION', 'COLLECTION_MEDIA', 'DESIGN', 'PRODUCT', 'COMMENT'].includes(type) ||
      !resourceUuid.test(id) || !client.rooms.has(room)) return;
    await client.leave(room);
    if (client.connected) client.emit('left', { room });
  }

  private *socketBatches(room: string): Generator<Socket[]> {
    const members = this.server.sockets.adapter.rooms.get(room);
    if (!members) return;
    const iterator = members.values(); let remaining = members.size;
    // Bounded cursor: concurrent joins cannot extend a delivery indefinitely.
    while (remaining > 0) {
      const batch: Socket[] = [];
      while (remaining > 0 && batch.length < 100) {
        remaining--;
        const next = iterator.next(); if (next.done) { remaining = 0; break; }
        const socket = this.server.sockets.sockets.get(next.value); if (socket) batch.push(socket);
      }
      if (batch.length) yield batch;
    }
  }

  async emitAuthorized(room: string, event: NotificationRealtimeEventName, payload: Record<string, unknown>): Promise<boolean> {
    try { return await this.realtimeBus.publishOrEmit({ room, event, payload }); }
    catch { this.logger.warn('Realtime delivery unavailable; persisted data remains authoritative'); return false; }
  }

  private async emitAuthorizedLocal(frame: NotificationRealtimeBusEvent): Promise<boolean> {
    if (!this.server || this.closed) return false;
    const [type, id] = frame.room.split(':');
    for (const batch of this.socketBatches(frame.room)) {
      const viewers = [...new Set<string>(batch.map(socket => socket.data.userId).filter(id => typeof id === 'string'))];
      const audience = type === 'USER' ? new Set([id]) : await contentAudience(this.prisma, type as ContentTarget, id, viewers);
      // Session verification is the last awaited boundary before local delivery.
      const eligible = await authorizedSockets(this.prisma, batch);
      if (this.closed) return false;
      for (const socket of eligible) {
        if (socket.connected && socket.rooms.has(frame.room) && socket.data.accessExpiresAt > Date.now() && audience.has(socket.data.userId))
          socket.emit(frame.event, frame.payload);
      }
    }
    return true; // No eligible recipients is handled, never a raw-broadcast fallback.
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
    void this.emitAuthorized(room, event, { ...payload, version: 1, ts: Date.now() });
  }

  // Comment events (rooms may be target rooms or COMMENT:{id} for threads on a comment)
  emitComment(
    event: 'comment.created' | 'comment.deleted' | 'comment.threaded',
    room: string,
    payload: any,
  ) {
    void this.emitAuthorized(room, event, { ...payload, version: 1, ts: Date.now() });
  }
}
