import { ConflictException, Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RefreshToken } from '@prisma/client';
import Redis from 'ioredis';
import { buildRedisConnection } from 'src/queue/queue.config';
import { PrismaService } from 'src/prisma/prisma.service';
import type { SecurityActor } from './security-actor';
import { evaluateSessionRisk, type SessionRiskState } from './session-risk.engine';

// One bounded, five-minute bucket per authenticated session, shared by replicas.
// Redis TIME and a monotonic cursor handle concurrency and process restarts.
const OBSERVE = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local stamp = tonumber(ARGV[3])
local reset = tonumber(redis.call('HGET', KEYS[1], 'reset')) or 0
local verified = tonumber(redis.call('HGET', KEYS[1], 'verified')) or 0
if reset <= now or stamp > verified then
  redis.call('HSET', KEYS[1], 'reads', 0, 'denials', 0, 'reset', now + 300000, 'verified', stamp)
end
local seq = math.max(tonumber(redis.call('HGET', KEYS[1], 'seq')) or 0, tonumber(ARGV[2]), now * 1000) + 1
redis.call('HSET', KEYS[1], 'seq', seq)
if ARGV[1] == 'read' then redis.call('HINCRBY', KEYS[1], 'reads', 1) end
if ARGV[1] == 'denial' then redis.call('HINCRBY', KEYS[1], 'denials', 1) end
redis.call('PEXPIRE', KEYS[1], 360000)
return {now, seq, tonumber(redis.call('HGET', KEYS[1], 'reads')) or 0, tonumber(redis.call('HGET', KEYS[1], 'denials')) or 0}
`;

@Injectable()
export class SessionRiskService implements OnModuleDestroy {
  private readonly redis: Redis;
  private connecting?: Promise<void>;
  private closed = false;
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {
    if (!['observe', 'enforce'].includes(config.get<string>('SECURITY_RISK_MODE', 'observe'))) throw new Error('SECURITY_RISK_MODE must be observe or enforce');
    this.redis = new Redis({ ...buildRedisConnection(config), enableOfflineQueue: false, commandTimeout: 1000, maxRetriesPerRequest: 1 });
    this.redis.on('error', () => undefined); // Availability is reported by observe; never log credentials.
  }
  private async counters(actor: SecurityActor, kind: 'read' | 'denial' | 'request', sequence = 0, verifiedAt = 0) {
    if (this.closed) throw new ServiceUnavailableException('Security checks are temporarily unavailable');
    try {
      if (this.redis.status === 'wait' && !this.connecting) {
        this.connecting = this.redis.connect().finally(() => { this.connecting = undefined; });
      }
      if (this.connecting) await this.connecting;
      return await this.redis.eval(OBSERVE, 1, `wiez:security:risk:v1:${actor.id}:${actor.sid}`, kind, sequence, verifiedAt) as [number, number, number, number];
    } catch { throw new ServiceUnavailableException('Security checks are temporarily unavailable'); }
  }
  async recordDenied(actor: SecurityActor) { await this.counters(actor, 'denial'); }

  async observe(actor: SecurityActor, session: Omit<RefreshToken, 'tokenHash'>, hints: { userAgent?: string; ip?: string }, sensitiveRead: boolean) {
    const sequence = Number(session.riskSequence);
    if (!Number.isSafeInteger(sequence)) throw new ServiceUnavailableException('Security state is unavailable');
    const [observedAt, nextSequence, sensitiveReads, deniedPrivilegeAttempts] = await this.counters(actor,
      sensitiveRead ? 'read' : 'request', sequence, session.strongAuthenticatedAt?.getTime() ?? 0);
    const previous: SessionRiskState = { actorId: actor.id, sessionId: actor.sid, authVersion: actor.authVersion,
      sequence, observedAt: session.riskObservedAt.getTime(), state: session.riskState, score: session.riskScore,
      reasons: session.riskReasons, reauthenticatedAt: session.strongAuthenticatedAt?.getTime() };
    let evaluated: SessionRiskState;
    try {
      evaluated = evaluateSessionRisk(previous, { actorId: actor.id, sessionId: actor.sid, authVersion: actor.authVersion,
        sequence: nextSequence, observedAt, sensitiveReads, deniedPrivilegeAttempts,
        deviceChanged: Boolean(session.userAgent && hints.userAgent && session.userAgent !== hints.userAgent),
        networkChanged: Boolean(session.ipAddress && hints.ip && session.ipAddress !== hints.ip),
      }, Date.now());
    } catch { throw new ServiceUnavailableException('Security state is unavailable'); }
    // Behavioral thresholds start observational; confirmed revocation and MFA
    // requirements are independent and can never be disabled by this setting.
    const enforceBehavior = this.config.get<string>('SECURITY_RISK_MODE', 'observe') === 'enforce';
    const state = evaluated.state === 'REVOKED' || session.riskState === 'CHALLENGE' || enforceBehavior ? evaluated.state : 'NORMAL';
    if (state !== session.riskState || evaluated.score !== session.riskScore) {
      const updated = await this.prisma.refreshToken.updateMany({ where: {
        id: actor.sid, userId: actor.id, sessionVersion: 1, issuedAuthVersion: actor.authVersion, riskState: { not: 'REVOKED' },
        expiresAt: { gt: new Date() }, riskSequence: { lt: BigInt(nextSequence) },
        strongAuthenticatedAt: session.strongAuthenticatedAt, user: { status: 'ACTIVE', authVersion: actor.authVersion },
      }, data: { riskState: state, riskScore: evaluated.score, riskSequence: BigInt(nextSequence),
        riskObservedAt: new Date(observedAt), riskReasons: evaluated.reasons } });
      if (updated.count !== 1) throw new ConflictException({ code: 'SECURITY_CONTEXT_CHANGED', message: 'Security context changed. Retry the request.' });
    }
    return { ...evaluated, state, observedAt };
  }
  async onModuleDestroy() {
    this.closed = true;
    this.redis.disconnect();
  }
}
