import { ConfigService } from '@nestjs/config';
import { EventsGateway } from './events.gateway';
import { NotificationRealtimeBusService } from './notification-realtime-bus.service';

describe('NotificationRealtimeBusService', () => {
  it('falls back to local Socket.io emit when Redis publisher is unavailable', async () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const service = new NotificationRealtimeBusService(
      { get: jest.fn() } as unknown as ConfigService,
      { server: { to } } as unknown as EventsGateway,
    );

    await expect(
      service.publishOrEmit({
        event: 'notification.created',
        room: 'USER:user-id',
        payload: { id: 'notification-id', isRead: false },
      }),
    ).resolves.toBe(true);

    expect(to).toHaveBeenCalledWith('USER:user-id');
    expect(emit).toHaveBeenCalledWith('notification.created', {
      id: 'notification-id',
      isRead: false,
    });
  });

  it('rejects malformed bus events before emitting locally', async () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const service = new NotificationRealtimeBusService(
      { get: jest.fn() } as unknown as ConfigService,
      { server: { to } } as unknown as EventsGateway,
    );

    await expect(
      service.publishOrEmit({
        event: 'notification.created',
        room: 'COLLECTION:collection-id',
        payload: { id: 'notification-id' },
      }),
    ).resolves.toBe(false);

    expect(to).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
