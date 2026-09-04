import { readDeviceId } from './device-id';

/**
 * Everything the counter needs from an HTTP request, extracted once.
 *
 * Its presence is also the SIGNAL: a service that receives one is serving a
 * real reader and should count the view; a service called internally receives
 * nothing and counts nothing. That is why this is a value passed down rather
 * than something the counter reaches up for.
 */
export type ViewRequestContext = {
  viewerRole?: string | null;
  deviceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Client-generated id that makes a retried delivery idempotent. */
  eventId?: string | null;
};

export function viewContextFromRequest(req: any): ViewRequestContext {
  return {
    viewerRole: req?.user?.role ?? null,
    deviceId: readDeviceId(req),
    ipAddress: req?.ip || req?.connection?.remoteAddress || null,
    userAgent: req?.headers?.['user-agent'] ?? null,
  };
}
