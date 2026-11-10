import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { SessionRiskService } from './session-risk.service';

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));

describe('risk counter connection readiness', () => {
  const actor = { id: 'fixture-user', sid: 'fixture-session', authVersion: 1, role: 'User' };
  const fixture = () => {
    let ready!: () => void;
    const connection = new Promise<void>(resolve => { ready = resolve; });
    const client = { status: 'connecting', on: jest.fn(), disconnect: jest.fn(),
      connect: jest.fn(async () => { client.status = 'connecting'; await connection; client.status = 'ready'; }),
      eval: jest.fn(async () => {
        if (client.status !== 'ready') throw Error('Stream is not writable and offline queue is disabled');
        return [Date.now(), 1, 0, 0];
      }) };
    (Redis as unknown as jest.Mock).mockImplementation(options => {
      client.status = options.lazyConnect ? 'wait' : 'connecting'; return client;
    });
    const service = new SessionRiskService({} as never, new ConfigService({ REDIS_HOST: '127.0.0.1' }));
    return { service, client, ready };
  };

  it('awaits one shared explicit connection before concurrent first commands', async () => {
    const { service, client, ready } = fixture();
    const first = service.recordDenied(actor), second = service.recordDenied(actor);
    // Attach rejection handlers before testing a deliberately pending connection.
    const completed = Promise.allSettled([first, second]);
    expect(client.eval).not.toHaveBeenCalled();
    expect(client.connect).toHaveBeenCalledTimes(1);
    ready();
    expect((await completed).every(result => result.status === 'fulfilled')).toBe(true);
    expect(client.eval).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });

  it('fails closed while reconnecting or after shutdown instead of queuing authority checks', async () => {
    const { service, client } = fixture(); client.status = 'reconnecting';
    await expect(service.recordDenied(actor)).rejects.toMatchObject({ status: 503 });
    await service.onModuleDestroy(); client.eval.mockClear();
    await expect(service.recordDenied(actor)).rejects.toMatchObject({ status: 503 });
    expect(client.eval).not.toHaveBeenCalled();
  });
});
