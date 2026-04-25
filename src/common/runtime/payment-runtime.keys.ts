export const PAYMENT_QUEUE_WORKER_HEARTBEAT_KEY =
  'threadly:runtime:payment:queue-worker:heartbeat';

export const PAYMENT_QUEUE_WORKER_HEARTBEAT_TTL_SECONDS = 120;

export const PAYMENT_CRON_HEARTBEAT_TTL_SECONDS = 24 * 60 * 60;

export const PAYMENT_UNIFIED_INIT_LOCK_TTL_MS = 45_000;

export function paymentCronHeartbeatKey(name: string): string {
  return `threadly:runtime:payment:cron:${String(name ?? '').trim().toLowerCase()}`;
}

export function paymentUnifiedInitLockKey(userId: string): string {
  return `threadly:runtime:payment:unified-init-lock:${String(userId ?? '').trim()}`;
}
