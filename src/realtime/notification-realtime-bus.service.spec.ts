import { ConfigService } from '@nestjs/config';
import { NotificationRealtimeBusService, type NotificationRealtimeBusEvent } from './notification-realtime-bus.service';

const id = '11111111-1111-4111-8111-111111111111';
const frame = (room = `USER:${id}`): NotificationRealtimeBusEvent => ({ event: 'notification.created', room, payload: { id: 'notice' } });
const setup = () => new NotificationRealtimeBusService({ get: () => undefined } as unknown as ConfigService);

describe('authorized realtime fanout bus', () => {
  it('passes local fallback through the registered authorization gate', async () => {
    const service = setup(), delivery = jest.fn().mockResolvedValue(true); service.registerLocalDelivery(delivery);
    await expect(service.publishOrEmit(frame())).resolves.toBe(true);
    expect(delivery).toHaveBeenCalledWith(frame()); await service.onModuleDestroy();
  });
  it('fails closed without a registered delivery gate', async () => {
    const service = setup(); await expect(service.publishOrEmit(frame())).resolves.toBe(false);
    await service.onModuleDestroy();
  });
  it('rejects malformed rooms, cross-scope events and oversized payloads before dispatch', async () => {
    const service = setup(), delivery = jest.fn(); service.registerLocalDelivery(delivery);
    for (const value of [frame('USER:invalid'), frame(`USER:${id}:extra`), frame(`COLLECTION:${id}`),
      { ...frame(), event: 'arbitrary.server.event' }, { ...frame(), payload: { large: 'a'.repeat(262145) } }])
      await expect(service.publishOrEmit(value as NotificationRealtimeBusEvent)).resolves.toBe(false);
    expect(delivery).not.toHaveBeenCalled(); await service.onModuleDestroy();
  });
  it('supports content updates and keeps unavailable delivery from falling back to a raw broadcast', async () => {
    const service = setup(), delivery = jest.fn().mockResolvedValue(false); service.registerLocalDelivery(delivery);
    const event: NotificationRealtimeBusEvent = { event: 'comment.created', room: `DESIGN:${id}`, payload: { commentId: id } };
    await expect(service.publishOrEmit(event)).resolves.toBe(false); expect(delivery).toHaveBeenCalledTimes(1);
    delivery.mockRejectedValueOnce(new Error('Authority unavailable'));
    await expect(service.publishOrEmit(event)).resolves.toBe(false); expect(delivery).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });
  it('serializes each room and shutdown releases queued work', async () => {
    const service = setup(); const releases: Array<(value: boolean) => void> = [];
    const delivery = jest.fn(() => new Promise<boolean>(resolve => releases.push(resolve)));
    service.registerLocalDelivery(delivery);
    const first = service.publishOrEmit(frame()); await Promise.resolve(); await Promise.resolve();
    const second = service.publishOrEmit({ ...frame(), payload: { id: 'second' } });
    await Promise.resolve(); await Promise.resolve(); expect(delivery).toHaveBeenCalledTimes(1);
    releases[0](true); await first; await Promise.resolve(); await Promise.resolve();
    expect(delivery).toHaveBeenCalledTimes(2);
    const queued = service.publishOrEmit(frame()); await service.onModuleDestroy();
    await expect(queued).resolves.toBe(false); releases[1](true); await second;
    await expect(service.publishOrEmit(frame())).resolves.toBe(false);
  });
});
