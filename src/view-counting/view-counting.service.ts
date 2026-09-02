import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHmac } from 'crypto';
import { createClient, type RedisClientType } from 'redis';
import { PrismaService } from '../prisma/prisma.service';

export type ViewTargetType = 'DESIGN' | 'PRODUCT';

export type RecordViewInput = {
  target: ViewTargetType;
  targetId: string;
  /** Owner of the content. Self-views are never counted. */
  ownerId?: string | null;
  viewerId?: string | null;
  /** Role from the JWT: console operators are not an audience. */
  viewerRole?: string | null;
  /**
   * Durable, client-generated device id. Survives sign-out, sign-in and app
   * restarts — which is what makes the dedupe hold across a login.
   */
  deviceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Client-generated event id. Makes a retried delivery idempotent. */
  eventId?: string | null;
};

export type ViewOutcomeReason =
  | 'counted'
  | 'duplicate'
  | 'replayed-event'
  | 'owner'
  | 'operator'
  | 'bot'
  | 'unidentified'
  | 'unavailable';

export type RecordViewOutcome = {
  counted: boolean;
  reason: ViewOutcomeReason;
};

/**
 * One view per viewer per item per window.
 *
 * 30 minutes is the standard analytics session gap (the same idle timeout GA
 * and most session models use), which makes the number readable as "how many
 * viewing sessions this item got" rather than an arbitrary cut. Coming back the
 * next morning is a second view; swiping past and back is not.
 */
const DEFAULT_WINDOW_SECONDS = 30 * 60;

/** Long enough to swallow a client retry, short enough to be free. */
const EVENT_IDEMPOTENCY_SECONDS = 300;

const FLUSH_INTERVAL_MS = 10_000;

/**
 * Console operators browse content to moderate it. Counting that as audience
 * means every item an admin reviews gains a view from the person judging it.
 */
const OPERATOR_ROLES = new Set(['Admin', 'SuperAdmin']);

/**
 * Deliberately conservative: it matches self-identifying automation, not
 * "anything unusual". A false positive silently loses a real view, which is
 * worse than letting an unknown agent through.
 */
const BOT_USER_AGENT =
  /bot|crawler|spider|crawl|slurp|bingpreview|facebookexternalhit|whatsapp|telegrambot|discordbot|embedly|quora link preview|pinterest|redditbot|applebot|ia_archiver|headlesschrome|lighthouse|gtmetrix|pingdom|uptimerobot|curl\/|wget\/|python-requests|axios\/|okhttp|go-http-client/i;

/**
 * Dedupe across EVERY identity we hold for this viewer, atomically.
 *
 * A signed-out shopper views a design (device key), signs in, and views it
 * again (user key + device key). Checking one key at a time would count that
 * twice; N separate `SET NX` calls are also not atomic under concurrent
 * requests from two tabs. So: if any key is already present, count nothing and
 * set nothing; otherwise set them all.
 */
const DEDUPE_LUA = `
  for i = 1, #KEYS do
    if redis.call('EXISTS', KEYS[i]) == 1 then
      return 0
    end
  end
  for i = 1, #KEYS do
    redis.call('SET', KEYS[i], '1', 'EX', ARGV[1])
  end
  return 1
`;

/** Atomic read-and-clear so increments are never lost mid-flush. */
const DRAIN_LUA = `
  local key = KEYS[1]
  local data = redis.call('HGETALL', key)
  if next(data) ~= nil then
    redis.call('DEL', key)
  end
  return data
`;

@Injectable()
export class ViewCountingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ViewCountingService.name);
  private redis: RedisClientType | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  private readonly pendingKey = 'wiez:views:pending';
  private readonly windowSeconds = (() => {
    const raw = Number(process.env.VIEW_DEDUPE_WINDOW_SECONDS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WINDOW_SECONDS;
  })();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    const redisUrl = String(process.env.REDIS_URL || '').trim();
    if (redisUrl) {
      const client = createClient({
        url: redisUrl,
        socket: { connectTimeout: 2_000 },
      });
      client.on('error', (err: any) => {
        this.logger.warn(`Redis error: ${err?.message || err}`);
      });
      try {
        await client.connect();
        this.redis = client as RedisClientType;
      } catch (err: any) {
        this.logger.warn(
          `View counting has no Redis; views will not be counted: ${err?.message || err}`,
        );
        await this.closeRedisClient(client as RedisClientType);
        this.redis = null;
      }
    } else {
      this.logger.warn('REDIS_URL is not set; views will not be counted.');
    }

    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    if (typeof (this.flushTimer as any)?.unref === 'function') {
      (this.flushTimer as any).unref();
    }
  }

  async onModuleDestroy() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    await this.flush();
    await this.closeRedisClient(this.redis);
    this.redis = null;
  }

  /**
   * `disconnect()` returns a promise that REJECTS when the socket is already
   * closed, so it must be awaited inside the catch — the same defect that once
   * stopped the worker from ever exiting cleanly.
   */
  private async closeRedisClient(client: RedisClientType | null) {
    if (!client) return;
    try {
      client.removeAllListeners();
      if (client.isOpen) await client.quit();
    } catch {
      try {
        await client.disconnect();
      } catch {
        // Socket already gone; nothing left to release.
      }
    }
  }

  /**
   * Pseudonymise an IP so it cannot be recovered from the database.
   *
   * Keyed HMAC, not a bare digest: the IPv4 space is small enough to enumerate,
   * so an unkeyed hash of an address is reversible in seconds. Falls back to
   * JWT_ACCESS_SECRET when no dedicated pepper is configured, and refuses to
   * produce a hash at all if neither exists rather than emitting a guessable
   * one.
   */
  hashIp(ip: string | null | undefined): string | null {
    const value = String(ip ?? '').trim();
    if (!value) return null;
    const pepper =
      process.env.VIEW_IP_HASH_SECRET || process.env.JWT_ACCESS_SECRET || '';
    if (!pepper) return null;
    return createHmac('sha256', pepper).update(value).digest('hex').slice(0, 32);
  }

  /**
   * Every identity we hold for this viewer, most durable first.
   *
   * The IP is a last resort and is used ONLY when nothing better exists. It
   * used to participate even for signed-in viewers, which meant one person in
   * an office or on shared home wifi suppressed everyone else on that network
   * for a full day.
   */
  private viewerKeys(input: RecordViewInput): string[] {
    const keys: string[] = [];
    if (input.viewerId) keys.push(`u:${input.viewerId}`);
    if (input.deviceId) keys.push(`d:${input.deviceId}`);
    if (keys.length === 0) {
      const ipHash = this.hashIp(input.ipAddress);
      if (ipHash) keys.push(`i:${ipHash}`);
    }
    return keys;
  }

  /**
   * Should this be counted, and if so record it.
   *
   * Fails CLOSED. If Redis is unavailable we cannot tell a first view from a
   * hundredth, and a view count that quietly doubles during an outage is worse
   * than one that under-reports: a brand can live with a number that is
   * conservative, not with one it stops believing.
   */
  async record(input: RecordViewInput): Promise<RecordViewOutcome> {
    if (!input.targetId) return { counted: false, reason: 'unidentified' };

    if (input.viewerId && input.ownerId && input.viewerId === input.ownerId) {
      return { counted: false, reason: 'owner' };
    }
    if (input.viewerRole && OPERATOR_ROLES.has(input.viewerRole)) {
      return { counted: false, reason: 'operator' };
    }
    if (input.userAgent && BOT_USER_AGENT.test(input.userAgent)) {
      return { counted: false, reason: 'bot' };
    }

    const keys = this.viewerKeys(input);
    if (keys.length === 0) return { counted: false, reason: 'unidentified' };

    const redis = this.redis;
    if (!redis) return { counted: false, reason: 'unavailable' };

    const scope = `${input.target}:${input.targetId}`;

    try {
      // Idempotency first: a retried batch must not consume the dedupe window
      // and must not count twice.
      if (input.eventId) {
        const fresh = await redis.set(
          `wiez:views:evt:${input.eventId}`,
          '1',
          { EX: EVENT_IDEMPOTENCY_SECONDS, NX: true },
        );
        if (fresh === null) return { counted: false, reason: 'replayed-event' };
      }

      const allowed = (await redis.eval(DEDUPE_LUA, {
        keys: keys.map((key) => `wiez:views:seen:${scope}:${key}`),
        arguments: [String(this.windowSeconds)],
      })) as number;

      if (Number(allowed) !== 1) return { counted: false, reason: 'duplicate' };

      await redis.hIncrBy(this.pendingKey, scope, 1);
      return { counted: true, reason: 'counted' };
    } catch (err: any) {
      this.logger.warn(`View not counted: ${err?.message || err}`);
      return { counted: false, reason: 'unavailable' };
    }
  }

  /**
   * Move buffered counts into the denormalised columns.
   *
   * `increment` rather than a recount: the previous design ran a full
   * `COUNT(*)` over the View table on every single view.
   */
  private async flush() {
    const redis = this.redis;
    if (!redis) return;

    let raw: string[];
    try {
      raw = (await redis.eval(DRAIN_LUA, {
        keys: [this.pendingKey],
        arguments: [],
      })) as string[];
    } catch (err: any) {
      this.logger.warn(`View flush failed: ${err?.message || err}`);
      return;
    }
    if (!Array.isArray(raw) || raw.length === 0) return;

    const designs = new Map<string, number>();
    const products = new Map<string, number>();
    for (let i = 0; i < raw.length; i += 2) {
      const scope = raw[i];
      const count = Number(raw[i + 1] || 0);
      if (!scope || !Number.isFinite(count) || count <= 0) continue;
      const separator = scope.indexOf(':');
      if (separator < 0) continue;
      const type = scope.slice(0, separator);
      const id = scope.slice(separator + 1);
      if (!id) continue;
      if (type === 'DESIGN') designs.set(id, (designs.get(id) ?? 0) + count);
      else if (type === 'PRODUCT') {
        products.set(id, (products.get(id) ?? 0) + count);
      }
    }

    await Promise.all([
      this.applyIncrements('collection', designs),
      this.applyIncrements('product', products),
    ]);
  }

  private async applyIncrements(
    model: 'collection' | 'product',
    counts: Map<string, number>,
  ) {
    if (counts.size === 0) return;
    const entries = Array.from(counts.entries());
    for (let i = 0; i < entries.length; i += 250) {
      const chunk = entries.slice(i, i + 250);
      try {
        await this.prisma.$transaction(
          chunk.map(([id, count]) =>
            (this.prisma as any)[model].update({
              where: { id },
              data: { viewsCount: { increment: count } },
            }),
          ),
        );
      } catch (err: any) {
        // A deleted item makes the whole chunk fail. Retry singly so one
        // removed design cannot discard 249 real counts.
        for (const [id, count] of chunk) {
          try {
            await (this.prisma as any)[model].update({
              where: { id },
              data: { viewsCount: { increment: count } },
            });
          } catch {
            // Target is gone. Nothing to count against.
          }
        }
        void err;
      }
    }
  }
}
