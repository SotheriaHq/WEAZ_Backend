/* Test-only fakes for the telegram-monitoring specs. Not imported by runtime code. */
import { TelegramMonitoringConfig } from '../telegram-monitoring.config';

export const VALID_TOKEN = '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export function fakeConfig(env: Record<string, string> = {}): TelegramMonitoringConfig {
  const values: Record<string, string> = {
    TELEGRAM_MONITORING_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: VALID_TOKEN,
    TELEGRAM_ADMIN_CHAT_ID: '5229816265',
    TELEGRAM_ENVIRONMENT: 'SIT',
    SENTRY_ALERT_ENVIRONMENTS: 'sit',
    ...env,
  };
  const configService = { get: (key: string) => values[key] } as any;
  return new TelegramMonitoringConfig(configService);
}

/** Minimal in-memory Redis covering the commands this module uses. */
export class FakeRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  lists = new Map<string, string[]>();
  failAll = false;

  private guard() {
    if (this.failAll) throw new Error('redis down');
  }

  async get(key: string) {
    this.guard();
    return this.strings.get(key) ?? null;
  }
  async set(key: string, value: string, ...args: Array<string | number>) {
    this.guard();
    if (args.includes('NX') && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }
  async del(key: string) {
    this.guard();
    return this.strings.delete(key) ? 1 : 0;
  }
  async incr(key: string) {
    this.guard();
    const next = Number(this.strings.get(key) ?? 0) + 1;
    this.strings.set(key, String(next));
    return next;
  }
  async expire() {
    this.guard();
    return 1;
  }
  async ping() {
    this.guard();
    return 'PONG';
  }
  async hget(key: string, field: string) {
    this.guard();
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hset(key: string, field: string, value: string) {
    this.guard();
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)!.set(field, value);
    return 1;
  }
  async hdel(key: string, field: string) {
    this.guard();
    return this.hashes.get(key)?.delete(field) ? 1 : 0;
  }
  async hgetall(key: string) {
    this.guard();
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }
  async lrange(key: string, start: number, stop: number) {
    this.guard();
    return (this.lists.get(key) ?? []).slice(start, stop + 1);
  }
  multi() {
    const ops: Array<() => Promise<unknown>> = [];
    const chain: any = {
      hincrby: (key: string, field: string, by: number) => {
        ops.push(async () => {
          const current = Number((await this.hget(key, field)) ?? 0);
          await this.hset(key, field, String(current + by));
          return current + by;
        });
        return chain;
      },
      hgetall: (key: string) => {
        ops.push(() => this.hgetall(key));
        return chain;
      },
      expire: () => {
        ops.push(() => this.expire());
        return chain;
      },
      lpush: (key: string, value: string) => {
        ops.push(async () => {
          const list = this.lists.get(key) ?? [];
          list.unshift(value);
          this.lists.set(key, list);
          return list.length;
        });
        return chain;
      },
      ltrim: (key: string, start: number, stop: number) => {
        ops.push(async () => {
          this.lists.set(key, (this.lists.get(key) ?? []).slice(start, stop + 1));
          return 'OK';
        });
        return chain;
      },
      exec: async () => {
        this.guard();
        const results: Array<[Error | null, unknown]> = [];
        for (const op of ops) results.push([null, await op()]);
        return results;
      },
    };
    return chain;
  }
}

export function fakeQueue(redis: FakeRedis | null) {
  return {
    client: redis ? Promise.resolve(redis) : new Promise(() => undefined),
    add: jest.fn().mockResolvedValue({ id: 'job' }),
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0, delayed: 0, failed: 0, paused: 0 }),
    getFailed: jest.fn().mockResolvedValue([]),
  } as any;
}
