export const PAYMENT_QUEUE_WORKER_HEARTBEAT_KEY =
  'threadly:runtime:payment:queue-worker:heartbeat';

export const PAYMENT_QUEUE_WORKER_HEARTBEAT_TTL_SECONDS = 120;

export const PAYMENT_CRON_HEARTBEAT_TTL_SECONDS = 24 * 60 * 60;

export function paymentCronHeartbeatKey(name: string): string {
  return `threadly:runtime:payment:cron:${String(name ?? '').trim().toLowerCase()}`;
}
