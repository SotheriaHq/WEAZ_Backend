/** Prisma adapters can wrap PostgreSQL SQLSTATE below meta.driverAdapterError.cause. */
export function isSecurityTransactionConflict(error: unknown): boolean {
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return false;
    seen.add(value);
    const issue = value as Record<string, unknown>;
    if (issue.code === 'P2034' || issue.kind === 'TransactionWriteConflict' ||
      ['40001', '40P01'].includes(String(issue.code ?? '')) ||
      ['40001', '40P01'].includes(String(issue.originalCode ?? ''))) return true;
    return ['meta', 'cause', 'driverAdapterError'].some(key => visit(issue[key], depth + 1));
  };
  return visit(error, 0);
}
