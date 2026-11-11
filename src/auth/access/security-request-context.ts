import { AsyncLocalStorage } from 'async_hooks';
import type { Prisma } from '@prisma/client';
import type { AdaptiveOperation } from './adaptive-access.service';
import { ConflictException } from '@nestjs/common';

export type SecurityLease = { readonly active: boolean; close(): void };
export function createSecurityLease(): SecurityLease {
  let active = true;
  return { get active() { return active; }, close() { active = false; } };
}
export const securityRequestContext = new AsyncLocalStorage<{
  operation: AdaptiveOperation;
  request: SecurityLease;
  riskObservation?: Readonly<{ actorId: string; sessionId: string; authVersion: number; observedAt: number }>;
  transaction?: Prisma.TransactionClient;
  transactionLease?: SecurityLease;
}>();

export function getLiveSecurityContext() {
  const context = securityRequestContext.getStore();
  if (!context) return undefined;
  if (!context.request?.active) throw new ConflictException({ code: 'SECURITY_REQUEST_ENDED', message: 'This request ended. Start the action again.' });
  if (context.transaction && !context.transactionLease?.active) throw new ConflictException({ code: 'SECURITY_TRANSACTION_ENDED', message: 'This transaction ended. Start the action again.' });
  return context;
}
