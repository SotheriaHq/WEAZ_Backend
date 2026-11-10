import type { Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { authorizedSockets } from './socket-authority';
import { EventsGateway } from './events.gateway';
import { NotificationRealtimeBusService } from './notification-realtime-bus.service';

function fixture() {
  const id = randomUUID(), sid = randomUUID();
  const row = { id: sid, userId: id, sessionVersion: 1, issuedAuthVersion: 2, riskState: 'NORMAL', expiresAt: new Date(Date.now() + 60000),
    parentSessionId: null as string | null, parentUserId: null as string | null, parentSessionVersion: null as number | null,
    parentIssuedAuthVersion: null as number | null, parentRiskState: null as string | null, parentExpiresAt: null as Date | null,
    role: 'User', status: 'ACTIVE', authVersion: 2, mustResetPassword: false };
  const socket = { id: randomUUID(), connected: true, data: { userId: id, accessExpiresAt: Date.now() + 60000,
    principalClaims: { sub: id, sid, authVersion: 2, role: 'User' } }, rooms: new Set([`USER:${id}`]),
    disconnect: jest.fn(), emit: jest.fn() } as unknown as Socket;
  const prisma = { $queryRaw: jest.fn().mockResolvedValue([row]) } as any;
  return { id, sid, row, socket, prisma };
}
describe('batched current socket authority', () => {
  it('loads one bounded session query for one hundred connections, including multiple tabs on one session', async () => {
    const f = fixture(); const sockets = Array.from({ length: 100 }, (_, i) => ({ ...f.socket, id: `socket-${i}` } as Socket));
    expect(await authorizedSockets(f.prisma, sockets)).toHaveLength(100);
    expect(f.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    await expect(authorizedSockets(f.prisma, [...sockets, f.socket])).rejects.toThrow('bounded batches');
    expect(f.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
  it.each(['missing', 'version', 'revision', 'role', 'disabled', 'expired', 'parent'] as const)('rejects and disconnects %s authority', async kind => {
    const f = fixture();
    if (kind === 'missing') f.prisma.$queryRaw.mockResolvedValue([]);
    if (kind === 'version') f.row.sessionVersion = 0;
    if (kind === 'revision') f.row.issuedAuthVersion = 1;
    if (kind === 'role') f.row.role = 'Admin';
    if (kind === 'disabled') f.row.status = 'SUSPENDED';
    if (kind === 'expired') f.socket.data.accessExpiresAt = Date.now() - 1;
    if (kind === 'parent') { f.row.parentSessionId = randomUUID(); f.row.parentUserId = f.id;
      f.row.parentSessionVersion = 1; f.row.parentIssuedAuthVersion = 1; f.row.parentExpiresAt = f.row.expiresAt; f.row.parentRiskState = 'NORMAL'; }
    expect(await authorizedSockets(f.prisma, [f.socket])).toEqual([]); expect(f.socket.disconnect).toHaveBeenCalledWith(true);
  });
  it('pauses challenged presence/delivery without disconnecting recovery', async () => {
    const f = fixture(); f.row.riskState = 'CHALLENGE';
    expect(await authorizedSockets(f.prisma, [f.socket])).toEqual([]); expect(f.socket.disconnect).not.toHaveBeenCalled();
  });
  it('never treats unavailable database authority as permission to deliver', async () => {
    const f = fixture(); f.prisma.$queryRaw.mockRejectedValue(new Error('Unavailable'));
    await expect(authorizedSockets(f.prisma, [f.socket])).rejects.toThrow('Unavailable');
    expect(f.socket.emit).not.toHaveBeenCalled();
  });
});

describe('authorized local room delivery', () => {
  it('visits every socket across batch boundaries without a full-room fetch or raw broadcast', async () => {
    const f = fixture(); const config = { get: () => undefined } as any;
    const bus = new NotificationRealtimeBusService(config), gateway = new EventsGateway(f.prisma, config, bus);
    const sockets = Array.from({ length: 211 }, () => ({ ...f.socket, id: randomUUID(), emit: jest.fn() } as unknown as Socket));
    gateway.server = { sockets: { adapter: { rooms: new Map([[`USER:${f.id}`, new Set(sockets.map(socket => socket.id))]]) },
      sockets: new Map(sockets.map(socket => [socket.id, socket])) } } as any;
    gateway.onModuleInit();
    expect(await gateway.emitAuthorized(`USER:${f.id}`, 'notification.created', { id: 'fixture' })).toBe(true);
    for (const socket of sockets) expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(f.prisma.$queryRaw).toHaveBeenCalledTimes(3);
    gateway.onModuleDestroy(); await bus.onModuleDestroy();
  });
  it('skips a room member whose current account differs from its USER room and does not leak after shutdown', async () => {
    const f = fixture(); const config = { get: () => undefined } as any;
    const bus = new NotificationRealtimeBusService(config), gateway = new EventsGateway(f.prisma, config, bus);
    const room = `USER:${randomUUID()}`;
    gateway.server = { sockets: { adapter: { rooms: new Map([[room, new Set([f.socket.id])]]) },
      sockets: new Map([[f.socket.id, f.socket]]) } } as any;
    gateway.onModuleInit(); expect(await gateway.emitAuthorized(room, 'notification.created', { id: 'private' })).toBe(true);
    expect(f.socket.emit).not.toHaveBeenCalled();
    gateway.onModuleDestroy(); expect(await gateway.emitAuthorized(room, 'notification.created', {})).toBe(false);
    await bus.onModuleDestroy();
  });
});
