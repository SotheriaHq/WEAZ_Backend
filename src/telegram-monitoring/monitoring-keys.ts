import { createHash } from 'crypto';

/**
 * Redis keys, always scoped by environment label so SIT and a future UAT that
 * share a Redis can never read each other's counters or dedupe markers.
 */
export const monitoringKeys = (environment: string) => {
  const root = `wiez:tgmon:${environment.toLowerCase()}`;
  return {
    /** HASH eventKey -> count, one per UTC hour. */
    counter: (bucket: string) => `${root}:count:${bucket}`,
    /** STRING marker: this idempotency key was delivered. */
    sent: (id: string) => `${root}:sent:${id}`,
    /** STRING counter for threshold policies. */
    threshold: (eventKey: string, bucket: number) =>
      `${root}:thr:${eventKey}:${bucket}`,
    /** STRING cooldown marker (Sentry repeat suppression, watchdog repeats). */
    cooldown: (id: string) => `${root}:cooldown:${id}`,
    /** STRING JSON delivery record for one report window. */
    report: (kind: string, windowEndIso: string) =>
      `${root}:report:${kind}:${windowEndIso}`,
    /** LIST of recent report delivery records (audit trail, capped). */
    reportLog: () => `${root}:report-log`,
    /** HASH watchdog condition -> 'bad' state. */
    watchState: () => `${root}:watch:state`,
    /** HASH queue -> last seen failed count. */
    queueFailed: () => `${root}:watch:queue-failed`,
  };
};

export const COUNTER_TTL_SECONDS = 8 * 24 * 60 * 60;
export const SENT_MARKER_TTL_SECONDS = 14 * 24 * 60 * 60;
export const REPORT_RECORD_TTL_SECONDS = 35 * 24 * 60 * 60;

export function stableId(
  ...parts: Array<string | number | null | undefined>
): string {
  return createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\u001f'))
    .digest('hex')
    .slice(0, 40);
}
