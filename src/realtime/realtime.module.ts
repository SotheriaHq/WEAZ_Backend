import { Module } from '@nestjs/common';
import { EventsGateway } from './events.gateway';

/**
 * The ONLY place `EventsGateway` is provided. Import this module; never list the
 * gateway in another module's `providers`.
 *
 * Nest instantiates a provider once PER MODULE that lists it, and every
 * `@WebSocketGateway` instance binds its own handlers to the one socket.io
 * server. The gateway used to be listed in six modules (app, collections,
 * commentsv2, messaging, notifications, posts), so every connection ran
 * `handleConnection` — a JWT verify — six times, every `join` hit the database
 * and answered `joined` six times, and each instance added its own `disconnect`
 * listener to the socket. Past ten of those Node logs
 * `MaxListenersExceededWarning: 11 disconnect listeners added to [Socket]` on
 * every connection. It was never a slow leak; it was six gateways.
 *
 * Depends only on PrismaService and ConfigService, both global.
 * `realtime.module.spec.ts` fails if a module provides the gateway again.
 */
@Module({
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class RealtimeModule {}
